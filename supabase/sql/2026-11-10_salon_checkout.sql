-- Salon checkout + money (2026-11-10). Turns the shared payments module into a front-desk checkout for salons/spas.
--  invoices: tip_cents (added to the total), served_by (who did the work; defaults to the appointment's stylist), kind.
--  products: a simple retail list (price, taxable, stock) sold as invoice lines of kind 'product'.
--  gift_cards: sold as a line of kind 'gift_card_sale', redeemed as a negative line of kind 'gift_card' (balance moves on paid).
--  users: commission_pct / retail_commission_pct (admins only), used by the By-stylist report.
--  Reports: donna_staff_sales, donna_day_summary, donna_service_mix, donna_due_back (all scoped by current_account_id()).

-- ---------------------------------------------------------------- invoices
alter table public.invoices
  add column if not exists tip_cents integer not null default 0,
  add column if not exists served_by uuid references public.users(id) on delete set null,
  add column if not exists kind text not null default 'invoice';   -- invoice | ticket (salon checkout)
create index if not exists invoices_served_by on public.invoices (account_id, served_by);

create or replace function public.invoice_totals() returns trigger language plpgsql set search_path = public as $$
declare sub int := 0; tax int := 0; l jsonb;
begin
  for l in select * from jsonb_array_elements(coalesce(new.lines,'[]'::jsonb)) loop
    if coalesce(l->>'kind','service') = 'tax' then tax := tax + coalesce((l->>'cents')::int,0);
    else sub := sub + coalesce((l->>'cents')::int,0); end if;
  end loop;
  new.subtotal_cents := sub; new.tax_cents := tax; new.total_cents := sub + tax + coalesce(new.tip_cents,0);
  new.updated_at := now();
  return new;
end $$;

alter table public.payments add column if not exists tip_cents integer not null default 0;

-- ---------------------------------------------------------------- products (retail)
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  price_cents integer not null default 0,
  taxable boolean not null default true,
  stock integer,                       -- null = not tracked
  sku text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_account on public.products (account_id, is_active);
alter table public.products enable row level security;
create policy products_read on public.products for select to authenticated using (account_id = current_account_id());
create policy products_admin_write on public.products for all to authenticated
  using (account_id = current_account_id() and is_account_admin()) with check (account_id = current_account_id() and is_account_admin());

-- ---------------------------------------------------------------- gift cards
create table if not exists public.gift_cards (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  code text not null,
  initial_cents integer not null,
  balance_cents integer not null,
  purchaser_contact_id uuid references public.contacts(id) on delete set null,
  recipient_name text,
  recipient_phone text,
  sold_invoice_id uuid references public.invoices(id) on delete set null,
  status text not null default 'active',   -- active | used | void
  expires_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, code)
);
alter table public.gift_cards enable row level security;
create policy gift_cards_read on public.gift_cards for select to authenticated using (account_id = current_account_id());
create policy gift_cards_admin_write on public.gift_cards for all to authenticated
  using (account_id = current_account_id() and is_account_admin()) with check (account_id = current_account_id() and is_account_admin());

create table if not exists public.gift_card_moves (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  delta_cents integer not null,
  note text,
  created_at timestamptz not null default now()
);
alter table public.gift_card_moves enable row level security;
create policy gift_card_moves_read on public.gift_card_moves for select to authenticated
  using (exists (select 1 from gift_cards g where g.id = gift_card_id and g.account_id = current_account_id()));

-- ---------------------------------------------------------------- commission (admins set it; members can't touch their own)
alter table public.users
  add column if not exists commission_pct numeric(5,2) not null default 0,
  add column if not exists retail_commission_pct numeric(5,2) not null default 0;
create or replace function public.trg_users_commission_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_account_admin() then return new; end if;
  if new.commission_pct is distinct from old.commission_pct or new.retail_commission_pct is distinct from old.retail_commission_pct then
    raise exception 'Only an owner or manager can change commission.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create or replace trigger users_commission_guard before update on public.users for each row execute function public.trg_users_commission_guard();

-- ---------------------------------------------------------------- pay page: expose tip + whether tips are offered
create or replace function public.invoice_public(p_token text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency, 'kind', i.kind,
    'lines', i.lines, 'subtotal_cents', i.subtotal_cents, 'tax_cents', i.tax_cents, 'tip_cents', i.tip_cents, 'total_cents', i.total_cents,
    'notes', i.notes, 'customer_name', i.customer_name, 'service_address', i.service_address,
    'sent_at', i.sent_at, 'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_note', i.paid_note,
    'served_by_name', (select u.full_name from users u where u.id = i.served_by),
    'business', jsonb_build_object('name', a.name, 'phone', a.settings->'business'->>'phone', 'address', coalesce(a.settings->>'address', a.settings->>'office_address'), 'email', a.settings->'business'->>'email'),
    'can_pay_online', (i.status in ('sent','draft') and i.paid_at is null and coalesce(pa.charges_enabled,false) and coalesce((a.settings->'payments'->>'enabled')::boolean,false)),
    'tips_enabled', (i.kind = 'ticket' and coalesce((a.settings->'payments'->>'tips')::boolean, true)),
    'card_fee_pct', coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0),
    'card_fee_cents', round(i.total_cents * coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) / 100.0)::int
  )
  from invoices i join accounts a on a.id = i.account_id
  left join payment_accounts pa on pa.account_id = i.account_id
  where i.pay_token = p_token;
$$;

-- ---------------------------------------------------------------- reports
-- Per person: service / product / other sales, tips, cash vs card, commission owed. Tech = served_by, else job assignee, else creator.
create or replace function public.donna_staff_sales(p_from timestamptz default (now() - interval '30 days'), p_to timestamptz default now())
returns table (user_id uuid, full_name text, role text, is_active boolean, tickets integer, service_cents bigint, product_cents bigint, other_cents bigint, tip_cents bigint, cash_cents bigint, card_cents bigint, gift_cents bigint, commission_pct numeric, retail_commission_pct numeric, commission_cents bigint)
language sql security definer set search_path = public as $$
  with acct as (select current_account_id() id),
  inv as (
    select i.id, i.tip_cents, i.total_cents, i.paid_method, coalesce(i.served_by, j.assigned_user_id, i.created_by) who,
      (select coalesce(sum((l->>'cents')::int),0) from jsonb_array_elements(i.lines) l where coalesce(l->>'kind','service') in ('service','addon','labor')) svc,
      (select coalesce(sum((l->>'cents')::int),0) from jsonb_array_elements(i.lines) l where l->>'kind' = 'product') prod,
      (select coalesce(sum((l->>'cents')::int),0) from jsonb_array_elements(i.lines) l where coalesce(l->>'kind','service') not in ('service','addon','labor','product','tax')) oth
    from invoices i left join jobs j on j.id = i.job_id
    where i.account_id = (select id from acct) and i.status = 'paid' and i.paid_at >= p_from and i.paid_at < p_to
  )
  select u.id, u.full_name, u.role::text, u.is_active,
    count(inv.id)::int,
    coalesce(sum(inv.svc),0)::bigint, coalesce(sum(inv.prod),0)::bigint, coalesce(sum(inv.oth),0)::bigint, coalesce(sum(inv.tip_cents),0)::bigint,
    coalesce(sum(inv.total_cents) filter (where inv.paid_method in ('cash','check')),0)::bigint,
    coalesce(sum(inv.total_cents) filter (where inv.paid_method = 'card'),0)::bigint,
    coalesce(sum(inv.total_cents) filter (where inv.paid_method = 'gift_card'),0)::bigint,
    u.commission_pct, u.retail_commission_pct,
    (coalesce(sum(inv.svc),0) * u.commission_pct / 100 + coalesce(sum(inv.prod),0) * u.retail_commission_pct / 100)::bigint
  from users u left join inv on inv.who = u.id
  where u.account_id = (select id from acct) and is_account_admin()
  group by u.id, u.full_name, u.role, u.is_active, u.commission_pct, u.retail_commission_pct, u.created_at
  order by (u.role = 'owner') desc, u.created_at;
$$;
grant execute on function public.donna_staff_sales(timestamptz, timestamptz) to authenticated;

-- One day (shop time zone): totals by method, tips, tickets, open tickets, appointments not checked out yet.
create or replace function public.donna_day_summary(p_date date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_acct uuid := current_account_id(); v_tz text; v_from timestamptz; v_to timestamptz; v_day date; res jsonb;
begin
  if v_acct is null then return '{}'::jsonb; end if;
  select coalesce(settings->>'timezone','America/Chicago') into v_tz from accounts where id = v_acct;
  v_day := coalesce(p_date, (now() at time zone v_tz)::date);
  v_from := (v_day::timestamp) at time zone v_tz; v_to := ((v_day + 1)::timestamp) at time zone v_tz;
  select jsonb_build_object(
    'date', v_day,
    'tickets', (select count(*) from invoices where account_id = v_acct and status = 'paid' and paid_at >= v_from and paid_at < v_to),
    'sales_cents', (select coalesce(sum(total_cents - tip_cents),0) from invoices where account_id = v_acct and status = 'paid' and paid_at >= v_from and paid_at < v_to),
    'tip_cents', (select coalesce(sum(tip_cents),0) from invoices where account_id = v_acct and status = 'paid' and paid_at >= v_from and paid_at < v_to),
    'tax_cents', (select coalesce(sum(tax_cents),0) from invoices where account_id = v_acct and status = 'paid' and paid_at >= v_from and paid_at < v_to),
    'by_method', (select coalesce(jsonb_object_agg(m, c), '{}'::jsonb) from (select coalesce(paid_method,'other') m, sum(total_cents) c from invoices where account_id = v_acct and status = 'paid' and paid_at >= v_from and paid_at < v_to group by 1) x),
    'open_tickets', (select count(*) from invoices where account_id = v_acct and status in ('draft','sent') and created_at >= v_from and created_at < v_to),
    'open_cents', (select coalesce(sum(total_cents),0) from invoices where account_id = v_acct and status in ('draft','sent') and created_at >= v_from and created_at < v_to),
    'appointments', (select count(*) from appointments where account_id = v_acct and status <> 'cancelled' and starts_at >= v_from and starts_at < v_to),
    'not_checked_out', (select count(*) from appointments ap where ap.account_id = v_acct and ap.status <> 'cancelled' and ap.starts_at >= v_from and ap.starts_at < v_to and ap.ends_at < now()
                          and not exists (select 1 from invoices i where i.appointment_id = ap.id and i.status <> 'void'))
  ) into res;
  return res;
end $$;
grant execute on function public.donna_day_summary(date) to authenticated;

-- Which services sell: count and revenue by line description (service/addon lines on paid tickets), plus products.
create or replace function public.donna_service_mix(p_from timestamptz default (now() - interval '30 days'), p_to timestamptz default now())
returns table (kind text, name text, times integer, cents bigint)
language sql security definer set search_path = public as $$
  select case when coalesce(l->>'kind','service') = 'product' then 'product' else 'service' end,
         l->>'desc', count(*)::int, sum((l->>'cents')::int)::bigint
  from invoices i, jsonb_array_elements(i.lines) l
  where i.account_id = current_account_id() and i.status = 'paid' and i.paid_at >= p_from and i.paid_at < p_to
    and coalesce(l->>'kind','service') in ('service','addon','product')
  group by 1, 2 order by 4 desc;
$$;
grant execute on function public.donna_service_mix(timestamptz, timestamptz) to authenticated;

-- Clients due back: last completed visit older than the service's rebook window (default 42 days) and nothing upcoming.
create or replace function public.donna_due_back(p_limit int default 50)
returns table (contact_id uuid, name text, phone text, last_visit timestamptz, last_service text, days_since integer, rebook_after_days integer, stylist text)
language sql security definer set search_path = public as $$
  with lv as (
    select distinct on (a.contact_id) a.contact_id, a.starts_at, a.title, coalesce(t.rebook_after_days, 42) rb, a.user_id
    from appointments a left join appointment_types t on t.id = a.appointment_type_id
    where a.account_id = current_account_id() and a.status <> 'cancelled' and a.contact_id is not null and a.ends_at < now()
    order by a.contact_id, a.starts_at desc
  )
  select c.id, c.name, c.phone, l.starts_at, l.title, (extract(epoch from now() - l.starts_at)/86400)::int, l.rb,
    (select full_name from users where id = l.user_id)
  from lv l join contacts c on c.id = l.contact_id
  where now() - l.starts_at > make_interval(days => l.rb)
    and not exists (select 1 from appointments n where n.contact_id = c.id and n.status <> 'cancelled' and n.starts_at > now())
    and (is_account_admin() or l.user_id = auth.uid())
  order by l.starts_at asc limit p_limit;
$$;
grant execute on function public.donna_due_back(int) to authenticated;
