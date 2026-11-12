-- Rent collection (PM Donna + Real Estate Donna). Nov 12 2026.
-- One Stripe account per management company (payment_accounts). Tenants pay by bank (no fee), card or Cash App (card fee).
-- Partial payments off by default (settings.rent.allow_partial). A lease can be switched to "not accepting payments" (eviction).
-- Settings live in accounts.settings.rent: { enabled, grace_days, late_fee_cents, late_fee_pct, card_fee_pct, allow_partial, notify_days_before, bank_status }.

create table if not exists public.leases (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  property_contact_id uuid references public.property_contacts(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  tenant_name text not null,
  tenant_phone text, tenant_email text,
  label text not null,                                   -- address / unit the tenant rents
  owner_name text,                                       -- property owner (for owner reports)
  rent_cents integer not null check (rent_cents >= 0),
  due_day integer not null default 1 check (due_day between 1 and 28),
  start_date date not null,
  end_date date,
  first_month text not null default 'prorate' check (first_month in ('prorate','full','skip')),
  extras jsonb not null default '[]'::jsonb,             -- recurring extras: [{desc, cents}] (pet rent, parking)
  status text not null default 'active' check (status in ('active','ended')),
  block_payments boolean not null default false,         -- eviction / legal hold: pay page refuses money
  block_reason text,
  allow_partial boolean,                                 -- null = follow the account setting
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leases_account_idx on public.leases(account_id, status);
alter table public.leases enable row level security;
drop policy if exists leases_rw on public.leases;
create policy leases_rw on public.leases for all using (account_id = current_account_id()) with check (account_id = current_account_id() and is_account_admin());

alter table public.invoices add column if not exists lease_id uuid references public.leases(id) on delete set null;
create unique index if not exists invoices_lease_period_uidx on public.invoices(lease_id, period_key) where lease_id is not null and period_key is not null and status <> 'void';
create index if not exists invoices_lease_idx on public.invoices(lease_id) where lease_id is not null;

-- One row per Stripe Checkout started from a rent pay page. Full payoffs are settled by the payments webhook
-- (metadata.invoice_id); partial payments are settled by the rent function (return from checkout + daily/15-min sweep).
create table if not exists public.rent_sessions (
  id text primary key,                                   -- Stripe checkout session id
  account_id uuid not null references public.accounts(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  lease_id uuid references public.leases(id) on delete set null,
  amount_cents integer not null,                         -- rent applied (fee excluded)
  fee_cents integer not null default 0,
  method text not null,                                  -- bank | card
  partial boolean not null default false,
  status text not null default 'open' check (status in ('open','processing','paid','failed','expired')),
  payment_intent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rent_sessions_open_idx on public.rent_sessions(status, created_at) where status in ('open','processing');
create index if not exists rent_sessions_invoice_idx on public.rent_sessions(invoice_id);
alter table public.rent_sessions enable row level security;
drop policy if exists rent_sessions_select on public.rent_sessions;
create policy rent_sessions_select on public.rent_sessions for select using (account_id = current_account_id());

-- Pay page: rent invoices carry their own method list, the partial-payment switch and the "not accepting payments" flag.
create or replace function public.invoice_public(p_token text)
 returns jsonb language sql stable security definer set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency, 'kind', i.kind,
    'lines', i.lines, 'subtotal_cents', i.subtotal_cents, 'tax_cents', i.tax_cents, 'tip_cents', i.tip_cents, 'total_cents', i.total_cents,
    'notes', i.notes, 'customer_name', i.customer_name, 'service_address', i.service_address,
    'sent_at', i.sent_at, 'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_note', i.paid_note,
    'due_at', i.due_at, 'period_key', i.period_key,
    'served_by_name', (select u.full_name from users u where u.id = i.served_by),
    'business', jsonb_build_object('name', coalesce(c.name, a.name), 'managed_by', case when c.id is not null then a.name end, 'phone', a.settings->'business'->>'phone', 'address', coalesce(c.address, a.settings->>'address', a.settings->>'office_address'), 'email', a.settings->'business'->>'email'),
    'can_pay_online', (i.status in ('sent','draft') and i.paid_at is null and
        case when c.id is not null then coalesce(c.charges_enabled,false)
             when l.id is not null then (coalesce(pa.charges_enabled,false) and coalesce((a.settings->'rent'->>'enabled')::boolean,false) and not l.block_payments)
             else (coalesce(pa.charges_enabled,false) and coalesce((a.settings->'payments'->>'enabled')::boolean,false)) end),
    'tips_enabled', (i.kind = 'ticket' and coalesce((a.settings->'payments'->>'tips')::boolean, true)),
    'has_contact', (i.contact_id is not null),
    'unit', case when un.id is not null then jsonb_build_object('label', un.label, 'owner_name', un.owner_name, 'autopay', case when un.autopay is not null then jsonb_build_object('method', un.autopay->>'method', 'last4', un.autopay->>'last4') end) end,
    'bank_pay', (c.id is not null),
    'rent', case when l.id is not null then jsonb_build_object(
        'label', l.label, 'blocked', l.block_payments,
        'bank', (a.settings->'rent'->>'bank_status') = 'active',
        'cashapp', (pa.requirements->>'cashapp_payments') = 'active',
        'allow_partial', coalesce(l.allow_partial, (a.settings->'rent'->>'allow_partial')::boolean, false),
        'paid_cents', case when i.paid_at is null then coalesce((select sum(p.amount_cents) from payments p where p.invoice_id = i.id), 0) else 0 end,
        'processing', exists (select 1 from rent_sessions rs where rs.invoice_id = i.id and rs.status = 'processing'),
        'processing_cents', coalesce((select sum(rs.amount_cents) from rent_sessions rs where rs.invoice_id = i.id and rs.status = 'processing'), 0)) end,
    'card_fee_pct', case when c.id is not null then c.card_fee_pct when l.id is not null then coalesce((a.settings->'rent'->>'card_fee_pct')::numeric, 0) else coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) end,
    'card_fee_cents', round(i.total_cents * (case when c.id is not null then c.card_fee_pct when l.id is not null then coalesce((a.settings->'rent'->>'card_fee_pct')::numeric, 0) else coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) end) / 100.0)::int
  )
  from invoices i join accounts a on a.id = i.account_id
  left join payment_accounts pa on pa.account_id = i.account_id
  left join communities c on c.id = i.community_id
  left join units un on un.id = i.unit_id
  left join leases l on l.id = i.lease_id
  where i.pay_token = p_token;
$function$;

-- Sweep: bill upcoming rent, remind, late fees (daily work is idempotent) and settle checkouts still in flight. Every 15 minutes.
select cron.unschedule('donna-rent-sweep') where exists (select 1 from cron.job where jobname = 'donna-rent-sweep');
select cron.schedule('donna-rent-sweep', '7,22,37,52 * * * *', $c$
  select net.http_post(url := 'https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/rent',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from app_secrets where key='cron_secret')),
    body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 60000);
$c$);

-- Nov 12 (later): rent autopay and Donna's phone check for tenants calling from another number.
alter table public.leases add column if not exists autopay jsonb;             -- { customer, payment_method, method, last4, brand, enrolled_at }
alter table public.rent_sessions add column if not exists autopay text;        -- 'want' when the tenant ticked autopay at checkout, 'saved' once stored
create table if not exists public.rent_phone_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  lease_id uuid not null references public.leases(id) on delete cascade,
  caller text not null, code_hash text not null, attempts integer not null default 0,
  expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists rent_phone_codes_caller_idx on public.rent_phone_codes(account_id, caller, created_at);
alter table public.rent_phone_codes enable row level security;
-- invoice_public: the rent block also carries 'autopay' { method, last4 } (see the function in the database).
