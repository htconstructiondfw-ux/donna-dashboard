-- Donna platform billing (Sidekick Logistics bills each business for Donna).
-- One row per account. Written only by the billing edge function (service role); owners can read their own row.
create table if not exists public.account_billing (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  exempt boolean not null default false,              -- comped / test / internal accounts: never billed, never blocked
  stripe_customer_id text,
  stripe_subscription_id text,
  family text check (family in ('general','salon','industry')),
  tier text check (tier in ('starter','pro')),
  term text check (term in ('mtm','1y','2y')),
  sub_status text,                                    -- Stripe subscription status (trialing, active, past_due, canceled, unpaid, ...)
  trial_end timestamptz,
  trial_anchored_at timestamptz,                      -- when the trial was re-anchored to the first real call
  current_period_start timestamptz,
  current_period_end timestamptz,
  commitment_ends_at timestamptz,                     -- 1y / 2y plans: can't end before this
  cancel_at timestamptz,                              -- scheduled end (null = renews)
  card_brand text, card_last4 text,
  alert80_period timestamptz, alert100_period timestamptz,  -- usage emails already sent for this period start
  last_error text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.account_billing enable row level security;
drop policy if exists account_billing_select on public.account_billing;
create policy account_billing_select on public.account_billing for select using (account_id = current_account_id());

-- Overage lines added to renewal invoices (one per invoice, so webhook retries never double-bill).
create table if not exists public.billing_overages (
  invoice_id text primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  period_start timestamptz not null, period_end timestamptz not null,
  minutes integer not null, included integer not null, extra_minutes integer not null,
  cents integer not null, capped boolean not null default false,
  invoice_item_id text, created_at timestamptz not null default now()
);
alter table public.billing_overages enable row level security;
drop policy if exists billing_overages_select on public.billing_overages;
create policy billing_overages_select on public.billing_overages for select using (account_id = current_account_id());

-- Processed Stripe event ids (idempotency).
create table if not exists public.billing_events (id text primary key, type text, created_at timestamptz not null default now());
alter table public.billing_events enable row level security;

-- Billable minutes: time Donna spent on calls, spam and sub-10-second hang-ups excluded, rounded up to the minute.
create or replace function public.billable_minutes(p_account uuid, p_from timestamptz, p_to timestamptz)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(ceil(sum(duration_seconds) / 60.0), 0)::int
  from calls
  where account_id = p_account and started_at >= p_from and started_at < p_to
    and coalesce(is_spam, false) = false and coalesce(duration_seconds, 0) >= 10;
$$;
revoke all on function public.billable_minutes(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Everyone already on Donna today is a test or pilot account: exempt until moved to a paid plan.
insert into public.account_billing (account_id, exempt) select id, true from public.accounts
on conflict (account_id) do nothing;

-- Sweep: trial anchoring, commitment renewals, usage alerts. Every 15 minutes.
select cron.unschedule('donna-billing-sweep') where exists (select 1 from cron.job where jobname = 'donna-billing-sweep');
select cron.schedule('donna-billing-sweep', '*/15 * * * *', $c$
  select net.http_post(url := 'https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/billing',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from app_secrets where key='cron_secret')),
    body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 60000);
$c$);

-- Nov 11: commitments end -> month to month; reminders 30 and 7 days before the end.
alter table public.account_billing add column if not exists renew_notice30_for timestamptz, add column if not exists renew_notice7_for timestamptz, add column if not exists renewal_switched_at timestamptz;
