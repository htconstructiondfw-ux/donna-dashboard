-- Team foundation (Nov 9): one company, many logins, each person sees their own slice.
--  * users.is_active — deactivated people lose access everywhere (current_account_id() returns null for them)
--  * properties.manager_user_id — which property manager owns a property (PM Pro)
--  * invoices/estimates/jobs/service_requests/re_* get member-scoped RLS: owners/admins see everything in the
--    account; members see rows assigned to them (or unassigned). Account-level tables (contacts, knowledge,
--    calls, properties list) stay shared on purpose — a tech still needs the customer file.
--  * invoices_member_no_void: members cannot void or reprice (owner/admin only), enforced by trigger.

alter table public.users add column if not exists is_active boolean not null default true;
alter table public.users add column if not exists deactivated_at timestamptz;
alter table public.properties add column if not exists manager_user_id uuid references public.users(id) on delete set null;
create index if not exists properties_manager_idx on public.properties(manager_user_id);
create index if not exists re_listings_agent_idx on public.re_listings(agent_user_id);
create index if not exists re_leads_agent_idx on public.re_leads(agent_user_id);
create index if not exists invoices_created_by_idx on public.invoices(created_by);

-- Deactivated users have no account as far as RLS is concerned.
create or replace function public.current_account_id() returns uuid
language sql stable security definer set search_path = public as $$
  select account_id from users where id = auth.uid() and coalesce(is_active, true)
$$;
create or replace function public.is_account_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner','admin') and coalesce(is_active,true) from users where id = auth.uid()), false)
$$;

-- Does the current user manage this property (directly, or via its parent community)?
create or replace function public.manages_property(p_property uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from properties p
    where p.id = p_property
      and (p.manager_user_id = auth.uid()
           or (p.manager_user_id is null and p.parent_property_id is not null
               and exists (select 1 from properties pp where pp.id = p.parent_property_id and pp.manager_user_id = auth.uid()))
           or (p.manager_user_id is null and not exists (select 1 from properties pp2 where pp2.id = p.parent_property_id and pp2.manager_user_id is not null)))
  )
$$;

-- Invoices: members see the ones they created or whose job is theirs.
drop policy if exists invoices_rw on public.invoices;
create policy invoices_rw on public.invoices for all
  using (account_id = current_account_id() and (is_account_admin() or created_by = auth.uid()
         or exists (select 1 from jobs j where j.id = invoices.job_id and j.assigned_user_id = auth.uid())))
  with check (account_id = current_account_id());

drop policy if exists estimates_rw on public.estimates;
drop policy if exists estimates_tenant on public.estimates;
create policy estimates_rw on public.estimates for all
  using (account_id = current_account_id() and (is_account_admin() or created_by = auth.uid()
         or exists (select 1 from jobs j where j.id = estimates.job_id and j.assigned_user_id = auth.uid())))
  with check (account_id = current_account_id());

-- Property management: members (property managers) see their properties' people, requests, meetings.
-- Properties themselves: everyone can read the list (Donna and the team need names), members may edit only theirs.
drop policy if exists properties_rw on public.properties;
create policy properties_select on public.properties for select using (account_id = current_account_id());
create policy properties_write on public.properties for insert with check (account_id = current_account_id() and is_account_admin());
create policy properties_update on public.properties for update using (account_id = current_account_id() and (is_account_admin() or manages_property(id))) with check (account_id = current_account_id());
create policy properties_delete on public.properties for delete using (account_id = current_account_id() and is_account_admin());
drop policy if exists service_requests_rw on public.service_requests;
create policy service_requests_rw on public.service_requests for all
  using (account_id = current_account_id() and (is_account_admin() or manages_property(property_id) or manages_property(routed_property_id)))
  with check (account_id = current_account_id());
drop policy if exists property_contacts_rw on public.property_contacts;
create policy property_contacts_rw on public.property_contacts for all
  using (account_id = current_account_id() and (is_account_admin() or manages_property(property_id)))
  with check (account_id = current_account_id());
drop policy if exists pm_meetings_account on public.pm_meetings;
create policy pm_meetings_account on public.pm_meetings for all
  using (account_id = current_account_id() and (is_account_admin() or manages_property(property_id)))
  with check (account_id = current_account_id());

-- Real estate: agents see their own listings, leads and documents; unassigned rows are visible to everyone
-- so a new listing isn't invisible until the broker assigns it.
drop policy if exists re_listings_tenant on public.re_listings;
create policy re_listings_tenant on public.re_listings for all
  using (account_id = current_account_id() and (is_account_admin() or agent_user_id = auth.uid() or agent_user_id is null))
  with check (account_id = current_account_id());
drop policy if exists re_leads_tenant on public.re_leads;
create policy re_leads_tenant on public.re_leads for all
  using (account_id = current_account_id() and (is_account_admin() or agent_user_id = auth.uid() or agent_user_id is null))
  with check (account_id = current_account_id());
drop policy if exists re_documents_tenant on public.re_documents;
create policy re_documents_tenant on public.re_documents for all
  using (account_id = current_account_id() and (is_account_admin() or agent_user_id = auth.uid() or created_by = auth.uid()))
  with check (account_id = current_account_id());

-- Members cannot void an invoice or change its amounts once it has been sent; owners/admins can.
create or replace function public.invoices_member_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_account_admin() then return new; end if;
  if new.status = 'void' and old.status <> 'void' then
    raise exception 'Only an owner or manager can void an invoice.' using errcode = 'P0001';
  end if;
  if old.status <> 'draft' and (new.total_cents <> old.total_cents or new.lines::text <> old.lines::text) then
    raise exception 'Only an owner or manager can change a sent invoice.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists invoices_member_guard on public.invoices;
create trigger invoices_member_guard before update on public.invoices for each row execute function public.invoices_member_guard();

-- Signup trigger: staff titles come from the invite (set per vertical by create-staff), not hard-coded "Stylist".
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  new_account_id uuid;
  v_staff public.staff_invites;
begin
  v_staff := public.redeem_staff_invite(new.raw_user_meta_data->>'staff_token', new.email);
  if (new.raw_user_meta_data->>'staff_token') is not null and btrim(new.raw_user_meta_data->>'staff_token') <> '' then
    if v_staff.account_id is null then
      raise exception 'Invalid or used staff invite.' using errcode = 'P0001';
    end if;
    insert into users (id, account_id, full_name, email, phone, title, role, is_bookable)
    values (
      new.id,
      v_staff.account_id,
      coalesce(nullif(new.raw_user_meta_data->>'full_name',''), v_staff.full_name),
      new.email,
      nullif(new.raw_user_meta_data->>'phone',''),
      coalesce(nullif(new.raw_user_meta_data->>'title',''), 'Staff'),
      v_staff.role,
      v_staff.is_bookable
    );
    return new;
  end if;

  if not public.redeem_invite_code(new.raw_user_meta_data->>'invite_code', new.email) then
    raise exception 'A valid invite code is required to sign up.' using errcode = 'P0001';
  end if;

  insert into accounts (name, industry, settings)
  values (
    coalesce(nullif(new.raw_user_meta_data->>'company',''), 'My Business'),
    nullif(new.raw_user_meta_data->>'industry',''),
    jsonb_build_object('onboarding', jsonb_build_object('completed', false, 'step', 0, 'started_at', now()))
  )
  returning id into new_account_id;

  insert into users (id, account_id, full_name, email, phone, title, role)
  values (
    new.id, new_account_id,
    nullif(new.raw_user_meta_data->>'full_name',''), new.email,
    nullif(new.raw_user_meta_data->>'phone',''),
    coalesce(nullif(new.raw_user_meta_data->>'title',''), 'Owner'),
    'owner'
  );

  insert into assistants (account_id, assistant_name, greeting_label)
  values (new_account_id, 'Donna', 'the office');
  return new;
end $$;
