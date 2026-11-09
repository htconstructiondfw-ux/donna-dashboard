-- Recurring routes (weekly lawn, biweekly pool, monthly filters, quarterly pest). Visits are generated ahead
-- (lead_days) as appointments + jobs by the `routes` edge function; cron runs the generator nightly.
create table if not exists public.recurring_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  assigned_user_id uuid references public.users(id) on delete set null,
  title text not null,
  lines jsonb not null default '[]'::jsonb,
  customer_name text, customer_phone text, customer_email text, address text,
  frequency text not null default 'weekly' check (frequency in ('weekly','biweekly','monthly','quarterly')),
  weekday int check (weekday between 0 and 6),            -- weekly/biweekly: 0=Sun
  day_of_month int check (day_of_month between 1 and 28), -- monthly/quarterly
  time_local text not null default '09:00',
  duration_min int not null default 60,
  season_months int[] not null default '{}',              -- empty = all year; e.g. {3,4,5,6,7,8,9,10}
  skip_dates date[] not null default '{}',
  lead_days int not null default 14,
  anchor_date date not null default current_date,         -- biweekly/quarterly cadence counts from here
  paused boolean not null default false,
  last_generated_date date,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.jobs add column if not exists recurring_id uuid references public.recurring_jobs(id) on delete set null;
alter table public.jobs add column if not exists route_date date;
create unique index if not exists jobs_recurring_date_uq on public.jobs(recurring_id, route_date) where recurring_id is not null;
create index if not exists recurring_jobs_acct on public.recurring_jobs(account_id) where paused = false;
alter table public.recurring_jobs enable row level security;
drop policy if exists recurring_jobs_tenant on public.recurring_jobs;
create policy recurring_jobs_tenant on public.recurring_jobs for all
  using (account_id = (select account_id from public.users where id = auth.uid()))
  with check (account_id = (select account_id from public.users where id = auth.uid()));
grant select, insert, update, delete on public.recurring_jobs to authenticated;

-- Nightly generator (09:00 UTC = 3-4am Central).
select cron.unschedule('donna-routes-generate') where exists (select 1 from cron.job where jobname='donna-routes-generate');
select cron.schedule('donna-routes-generate', '0 9 * * *', $$
  select net.http_post(
    url:='https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/routes',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from app_secrets where key='cron_secret')),
    body:='{"action":"generate"}'::jsonb, timeout_milliseconds:=120000)
$$);

-- Card on file (payments.card_setup_send / invoice_charge_card): {payment_method, customer, brand, last4, saved_at} on the job.
alter table public.jobs add column if not exists card jsonb;
