-- HOA / community dues for PM Donna and Real Estate Donna. Applied to hingbdtmxozbjetzwibj on 2026-11-10 as migration hoa_dues.
-- Decisions (Hubert): dues monthly or annually per community; full amount only; autopay default bank debit (ACH), card +3%;
-- one Stripe connected account per community (the association is the merchant); payout to the HOA once a month.

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  address text,
  frequency text not null default 'monthly' check (frequency in ('monthly','annual')),
  due_day int not null default 1 check (due_day between 1 and 28),
  due_month int not null default 1 check (due_month between 1 and 12),      -- annual only
  dues_cents int not null default 0,                                        -- default per unit; a unit may override
  grace_days int not null default 10,
  late_fee_cents int not null default 0,
  card_fee_pct numeric(5,2) not null default 3.00,
  notify_days_before int not null default 10,                               -- invoices go out this many days before the due date
  payout_schedule text not null default 'monthly' check (payout_schedule in ('daily','weekly','monthly')),
  payout_day int not null default 10,
  stripe_account_id text,
  charges_enabled boolean not null default false,
  stripe_status text not null default 'not_connected',
  requirements jsonb,
  settings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists communities_account_idx on public.communities(account_id);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  label text not null,                                                      -- "123 Elm St" or "Lot 42" or "Unit 4B"
  owner_name text,
  owner_phone text,
  owner_email text,
  contact_id uuid references public.contacts(id) on delete set null,
  dues_cents int,                                                           -- override of the community default
  autopay jsonb,                                                            -- { method: 'bank'|'card', payment_method, customer, last4, bank_name, brand, enrolled_at }
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists units_community_idx on public.units(community_id);
create index if not exists units_account_idx on public.units(account_id);
create index if not exists units_phone_idx on public.units(account_id, owner_phone);

-- Dues invoices ride on the shared invoice engine.
alter table public.invoices add column if not exists community_id uuid references public.communities(id) on delete set null;
alter table public.invoices add column if not exists unit_id uuid references public.units(id) on delete set null;
alter table public.invoices add column if not exists due_at date;
alter table public.invoices add column if not exists period_key text;                 -- '2026-12' monthly, '2027' annual, 'A-<uuid>' assessment
alter table public.invoices add column if not exists autopay_attempts int not null default 0;
alter table public.invoices add column if not exists last_reminder_at timestamptz;
alter table public.invoices add column if not exists late_fee_applied_at timestamptz;
create unique index if not exists invoices_unit_period_uidx on public.invoices(unit_id, period_key) where unit_id is not null and period_key is not null and status <> 'void';
create index if not exists invoices_community_idx on public.invoices(community_id) where community_id is not null;

-- RLS: same shape as the rest — the account's admins; members read only.
alter table public.communities enable row level security;
alter table public.units enable row level security;
create policy communities_rw on public.communities for all to authenticated
  using (account_id = public.current_account_id()) with check (account_id = public.current_account_id() and public.is_account_admin());
create policy units_rw on public.units for all to authenticated
  using (account_id = public.current_account_id()) with check (account_id = public.current_account_id() and public.is_account_admin());

-- Pay page: dues invoices show community + unit, the community's card fee, autopay state, and pay-by-bank availability.
create or replace function public.invoice_public(p_token text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency, 'kind', i.kind,
    'lines', i.lines, 'subtotal_cents', i.subtotal_cents, 'tax_cents', i.tax_cents, 'tip_cents', i.tip_cents, 'total_cents', i.total_cents,
    'notes', i.notes, 'customer_name', i.customer_name, 'service_address', i.service_address,
    'sent_at', i.sent_at, 'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_note', i.paid_note,
    'due_at', i.due_at, 'period_key', i.period_key,
    'served_by_name', (select u.full_name from users u where u.id = i.served_by),
    'business', jsonb_build_object('name', coalesce(c.name, a.name), 'managed_by', case when c.id is not null then a.name end, 'phone', a.settings->'business'->>'phone', 'address', coalesce(c.address, a.settings->>'address', a.settings->>'office_address'), 'email', a.settings->'business'->>'email'),
    'can_pay_online', (i.status in ('sent','draft') and i.paid_at is null and
        case when c.id is not null then coalesce(c.charges_enabled,false) else (coalesce(pa.charges_enabled,false) and coalesce((a.settings->'payments'->>'enabled')::boolean,false)) end),
    'tips_enabled', (i.kind = 'ticket' and coalesce((a.settings->'payments'->>'tips')::boolean, true)),
    'has_contact', (i.contact_id is not null),
    'unit', case when un.id is not null then jsonb_build_object('label', un.label, 'owner_name', un.owner_name, 'autopay', case when un.autopay is not null then jsonb_build_object('method', un.autopay->>'method', 'last4', un.autopay->>'last4') end) end,
    'bank_pay', (c.id is not null),
    'card_fee_pct', case when c.id is not null then c.card_fee_pct else coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) end,
    'card_fee_cents', round(i.total_cents * (case when c.id is not null then c.card_fee_pct else coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) end) / 100.0)::int
  )
  from invoices i join accounts a on a.id = i.account_id
  left join payment_accounts pa on pa.account_id = i.account_id
  left join communities c on c.id = i.community_id
  left join units un on un.id = i.unit_id
  where i.pay_token = p_token;
$$;

-- Reports -------------------------------------------------------------------------------------------------------------
-- Collection status for a community and period: one row per unit.
create or replace function public.donna_dues_status(p_community uuid, p_period text)
returns table (unit_id uuid, label text, owner_name text, owner_phone text, owner_email text, autopay_method text, invoice_id uuid, number text, total_cents int, due_at date, status text, paid_at timestamptz, paid_method text, late_fee_applied_at timestamptz)
language sql stable security definer set search_path = public as $$
  select un.id, un.label, un.owner_name, un.owner_phone, un.owner_email, un.autopay->>'method',
         i.id, i.number, i.total_cents, i.due_at, i.status, i.paid_at, i.paid_method, i.late_fee_applied_at
  from units un
  left join invoices i on i.unit_id = un.id and i.period_key = p_period and i.status <> 'void'
  where un.community_id = p_community and un.account_id = public.current_account_id() and un.is_active
  order by un.label;
$$;

-- Delinquency: every unpaid dues invoice past due, oldest first, with days late.
create or replace function public.donna_dues_delinquent(p_community uuid)
returns table (unit_id uuid, label text, owner_name text, owner_phone text, invoice_id uuid, number text, total_cents int, due_at date, days_late int, period_key text)
language sql stable security definer set search_path = public as $$
  select un.id, un.label, un.owner_name, un.owner_phone, i.id, i.number, i.total_cents, i.due_at, (current_date - i.due_at)::int, i.period_key
  from invoices i join units un on un.id = i.unit_id
  where i.community_id = p_community and i.account_id = public.current_account_id() and i.kind = 'dues' and i.status in ('draft','sent') and i.due_at < current_date
  order by i.due_at, un.label;
$$;

-- Payout report: everything collected for a community in a calendar month, by resident (what the HOA's monthly deposit is made of).
create or replace function public.donna_dues_collected(p_community uuid, p_from timestamptz, p_to timestamptz)
returns table (paid_at timestamptz, label text, owner_name text, number text, period_key text, amount_cents int, method text, provider_ref text)
language sql stable security definer set search_path = public as $$
  select p.received_at, un.label, un.owner_name, i.number, i.period_key, p.amount_cents, p.method, p.provider_ref
  from payments p join invoices i on i.id = p.invoice_id left join units un on un.id = i.unit_id
  where i.community_id = p_community and i.account_id = public.current_account_id() and p.received_at >= p_from and p.received_at < p_to
  order by p.received_at;
$$;

-- Resident ledger / year-end statement.
create or replace function public.donna_unit_ledger(p_unit uuid, p_year int default null)
returns table (invoice_id uuid, number text, period_key text, due_at date, total_cents int, status text, paid_at timestamptz, paid_method text, lines jsonb)
language sql stable security definer set search_path = public as $$
  select i.id, i.number, i.period_key, i.due_at, i.total_cents, i.status, i.paid_at, i.paid_method, i.lines
  from invoices i join units un on un.id = i.unit_id
  where i.unit_id = p_unit and un.account_id = public.current_account_id() and i.status <> 'void'
    and (p_year is null or extract(year from coalesce(i.due_at, i.created_at::date)) = p_year)
  order by coalesce(i.due_at, i.created_at::date);
$$;

-- Community summary tiles.
create or replace function public.donna_dues_summary(p_community uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'units', (select count(*) from units where community_id = p_community and is_active),
    'autopay', (select count(*) from units where community_id = p_community and is_active and autopay is not null),
    'open_cents', (select coalesce(sum(total_cents),0) from invoices where community_id = p_community and kind = 'dues' and status in ('draft','sent')),
    'open_count', (select count(*) from invoices where community_id = p_community and kind = 'dues' and status in ('draft','sent')),
    'late_count', (select count(*) from invoices where community_id = p_community and kind = 'dues' and status in ('draft','sent') and due_at < current_date),
    'collected_month_cents', (select coalesce(sum(p.amount_cents),0) from payments p join invoices i on i.id = p.invoice_id where i.community_id = p_community and p.received_at >= date_trunc('month', now())),
    'collected_year_cents', (select coalesce(sum(p.amount_cents),0) from payments p join invoices i on i.id = p.invoice_id where i.community_id = p_community and p.received_at >= date_trunc('year', now()))
  )
  from communities c where c.id = p_community and c.account_id = public.current_account_id();
$$;

grant execute on function public.donna_dues_status(uuid, text), public.donna_dues_delinquent(uuid), public.donna_dues_collected(uuid, timestamptz, timestamptz), public.donna_unit_ledger(uuid, int), public.donna_dues_summary(uuid) to authenticated;
