-- Team Pro follow-ups (2026-11-09)
--  1. donna_tech_earnings(): per-person billed / paid / open totals for the owner's "By technician" card.
--  2. activity_log: who did what (void, reprice, mark paid, approve, deactivate, reassign). Admins of the account read it.
--     Dashboard-side changes (authenticated role) are captured by triggers; edge functions (service role) insert rows
--     explicitly with the acting user, so the triggers skip when auth.uid() is null to avoid double entries.

-- ---------------------------------------------------------------- 1. by technician
create or replace function public.donna_tech_earnings(p_from timestamptz default (now() - interval '30 days'), p_to timestamptz default now())
returns table (user_id uuid, full_name text, role text, is_active boolean, invoices integer, billed_cents bigint, paid_cents bigint, open_cents bigint, jobs_done integer)
language sql security definer set search_path = public as $$
  with acct as (select current_account_id() id),
  inv as (
    select i.id, i.total_cents, i.status, i.paid_at, coalesce(j.assigned_user_id, i.created_by) tech
    from invoices i left join jobs j on j.id = i.job_id
    where i.account_id = (select id from acct) and i.status <> 'void' and i.created_at >= p_from and i.created_at < p_to
  ),
  done as (
    select j.assigned_user_id tech, count(*) n from jobs j
    where j.account_id = (select id from acct) and j.done_at is not null and j.done_at >= p_from and j.done_at < p_to
    group by j.assigned_user_id
  )
  select u.id, u.full_name, u.role::text, u.is_active,
    count(inv.id)::int,
    coalesce(sum(inv.total_cents), 0)::bigint,
    coalesce(sum(inv.total_cents) filter (where inv.status = 'paid'), 0)::bigint,
    coalesce(sum(inv.total_cents) filter (where inv.status in ('draft','sent')), 0)::bigint,
    coalesce((select n from done where done.tech = u.id), 0)::int
  from users u
  left join inv on inv.tech = u.id
  where u.account_id = (select id from acct) and is_account_admin()
  group by u.id, u.full_name, u.role, u.is_active, u.created_at
  order by (u.role = 'owner') desc, u.created_at;
$$;
grant execute on function public.donna_tech_earnings(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------- 2. activity log
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
  actor_name text,
  action text not null,            -- invoice.void | invoice.reprice | invoice.paid | estimate.void | estimate.approve | user.deactivate | ...
  entity text not null,            -- invoice | estimate | user | property | listing | lead | job
  entity_id uuid,
  label text,                      -- INV-1007, "Marcus Reed", "118 Sunset Ridge"
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_account_created on public.activity_log (account_id, created_at desc);
alter table public.activity_log enable row level security;
create policy activity_log_admin_read on public.activity_log for select to authenticated
  using (account_id = current_account_id() and is_account_admin());
-- Nobody writes from the client; triggers (security definer) and service-role edge functions do.
revoke insert, update, delete on public.activity_log from authenticated, anon;

create or replace function public.log_activity(p_account uuid, p_actor uuid, p_action text, p_entity text, p_entity_id uuid, p_label text, p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if p_actor is not null then select full_name into v_name from users where id = p_actor; end if;
  insert into activity_log (account_id, actor_user_id, actor_name, action, entity, entity_id, label, details)
  values (p_account, p_actor, v_name, p_action, p_entity, p_entity_id, p_label, coalesce(p_details, '{}'::jsonb));
end $$;
grant execute on function public.log_activity(uuid, uuid, text, text, uuid, text, jsonb) to service_role;

-- Dashboard-side changes (auth.uid() present). Service-role writes skip (edge functions log themselves).
create or replace function public.trg_log_users() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.is_active is distinct from old.is_active then
    perform log_activity(new.account_id, auth.uid(), case when new.is_active then 'user.reactivate' else 'user.deactivate' end, 'user', new.id, new.full_name, '{}'::jsonb);
  end if;
  if new.role is distinct from old.role then
    perform log_activity(new.account_id, auth.uid(), 'user.role', 'user', new.id, new.full_name, jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  if new.is_bookable is distinct from old.is_bookable then
    perform log_activity(new.account_id, auth.uid(), case when new.is_bookable then 'user.bookable_on' else 'user.bookable_off' end, 'user', new.id, new.full_name, '{}'::jsonb);
  end if;
  return new;
end $$;
create or replace trigger users_log_activity after update on public.users for each row execute function public.trg_log_users();

create or replace function public.trg_log_assign() returns trigger language plpgsql security definer set search_path = public as $$
declare v_from uuid; v_to uuid; v_label text; v_entity text;
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'properties' then v_from := old.manager_user_id; v_to := new.manager_user_id; v_label := new.name; v_entity := 'property';
  elsif tg_table_name = 're_listings' then v_from := old.agent_user_id; v_to := new.agent_user_id; v_label := new.address; v_entity := 'listing';
  elsif tg_table_name = 're_leads' then v_from := old.agent_user_id; v_to := new.agent_user_id; v_label := coalesce(new.name, new.phone); v_entity := 'lead';
  elsif tg_table_name = 'jobs' then v_from := old.assigned_user_id; v_to := new.assigned_user_id; v_label := new.title; v_entity := 'job';
  else return new; end if;
  if v_from is distinct from v_to then
    perform log_activity(new.account_id, auth.uid(), v_entity || '.reassign', v_entity, new.id, v_label,
      jsonb_build_object('from', (select full_name from users where id = v_from), 'to', (select full_name from users where id = v_to)));
  end if;
  return new;
end $$;
create or replace trigger properties_log_assign after update of manager_user_id on public.properties for each row execute function public.trg_log_assign();
create or replace trigger re_listings_log_assign after update of agent_user_id on public.re_listings for each row execute function public.trg_log_assign();
create or replace trigger re_leads_log_assign after update of agent_user_id on public.re_leads for each row execute function public.trg_log_assign();
create or replace trigger jobs_log_assign after update of assigned_user_id on public.jobs for each row execute function public.trg_log_assign();

-- Invoices / estimates edited straight from the dashboard (rare; the functions do most of it).
create or replace function public.trg_log_money() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status is distinct from old.status and new.status in ('void','paid','approved') then
    perform log_activity(new.account_id, auth.uid(), tg_table_name || '.' || case new.status when 'void' then 'void' when 'paid' then 'paid' else 'approve' end,
      rtrim(tg_table_name, 's'), new.id, new.number, jsonb_build_object('total_cents', new.total_cents));
  end if;
  if new.lines is distinct from old.lines and old.status <> 'draft' then
    perform log_activity(new.account_id, auth.uid(), rtrim(tg_table_name, 's') || '.reprice', rtrim(tg_table_name, 's'), new.id, new.number,
      jsonb_build_object('from_cents', old.total_cents, 'to_cents', new.total_cents));
  end if;
  return new;
end $$;
create or replace trigger invoices_log_money after update on public.invoices for each row execute function public.trg_log_money();
create or replace trigger estimates_log_money after update on public.estimates for each row execute function public.trg_log_money();
