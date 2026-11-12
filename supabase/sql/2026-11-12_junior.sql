-- Donna for Junior Entrepreneurs (ages 8 to 17). Nov 12 2026.
-- One kid per account. The parent is the account owner (adult, pays, COPPA consent, owns Stripe); the kid has a
-- member login. Profile, business plan, savings goal and parent controls live in accounts.settings.junior.
-- Everything is written by the `junior` edge function (service role); members of the account can read.

create table if not exists public.junior_customers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  phone text, email text,
  street text,                                            -- where the job is; never read out by Donna
  notes text,
  status text not null default 'approved' check (status in ('pending','approved','declined')),
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists junior_customers_acct_idx on public.junior_customers(account_id, status);

create table if not exists public.junior_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  customer_id uuid references public.junior_customers(id) on delete set null,
  title text not null,
  job_date date not null,
  job_time text,                                          -- "15:30", optional
  repeat text not null default 'none' check (repeat in ('none','weekly','biweekly','monthly')),
  price_cents integer not null default 0 check (price_cents >= 0),
  status text not null default 'scheduled' check (status in ('scheduled','done','paid','canceled')),
  paid_method text, paid_at timestamptz,
  invoice_id uuid references public.invoices(id) on delete set null,
  series_id uuid,                                         -- repeating jobs share one series
  notes text,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists junior_jobs_acct_idx on public.junior_jobs(account_id, job_date);

create table if not exists public.junior_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('income','expense','saved')),
  amount_cents integer not null check (amount_cents > 0),
  category text, note text,
  happened_on date not null default current_date,
  job_id uuid references public.junior_jobs(id) on delete set null,
  created_by uuid, created_at timestamptz not null default now()
);
create index if not exists junior_ledger_acct_idx on public.junior_ledger(account_id, happened_on);
create unique index if not exists junior_ledger_job_uidx on public.junior_ledger(job_id) where job_id is not null and kind = 'income';

create table if not exists public.junior_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  unit text,                                              -- cups, bags, bottles
  qty numeric not null default 0,
  low_at numeric not null default 0,                      -- tell me when I have this many or fewer
  cost_cents integer,                                     -- what one costs to buy
  last_alert_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists junior_items_acct_idx on public.junior_items(account_id);

create table if not exists public.junior_posts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  platform text not null default 'any',                   -- instagram | facebook | tiktok | nextdoor | any
  caption text not null,
  picture_idea text,
  scheduled_at timestamptz,
  status text not null default 'draft' check (status in ('draft','needs_parent','approved','declined','reminded','posted')),
  parent_note text,
  reminded_at timestamptz, posted_at timestamptz,
  created_by uuid, decided_by uuid, decided_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists junior_posts_acct_idx on public.junior_posts(account_id, status, scheduled_at);

alter table public.junior_customers enable row level security;
alter table public.junior_jobs enable row level security;
alter table public.junior_ledger enable row level security;
alter table public.junior_items enable row level security;
alter table public.junior_posts enable row level security;
create policy junior_customers_select on public.junior_customers for select using (account_id = current_account_id());
create policy junior_jobs_select on public.junior_jobs for select using (account_id = current_account_id());
create policy junior_ledger_select on public.junior_ledger for select using (account_id = current_account_id());
create policy junior_items_select on public.junior_items for select using (account_id = current_account_id());
create policy junior_posts_select on public.junior_posts for select using (account_id = current_account_id());

-- Billing: the Junior plan ($10 a month, 20 call minutes and 50 texts, then 25 cents a minute and 3 cents a text;
-- two-way texting add-on $5 a month plus a one-time $20 setup).
alter table public.account_billing drop constraint if exists account_billing_family_check;
alter table public.account_billing add constraint account_billing_family_check check (family in ('general','salon','industry','junior'));
alter table public.account_billing add column if not exists texting_addon boolean not null default false, add column if not exists texting_addon_item text;
alter table public.billing_overages add column if not exists texts integer, add column if not exists extra_texts integer, add column if not exists text_cents integer;

-- Outbound texts Donna sent for an account in a period (the Junior plan meters these).
create or replace function public.billable_texts(p_account uuid, p_from timestamptz, p_to timestamptz)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from conversation_messages
  where account_id = p_account and channel = 'sms' and direction = 'outbound' and created_at >= p_from and created_at < p_to;
$$;
revoke all on function public.billable_texts(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Sweep: "time to post" reminders, low-stock alerts, repeating jobs. Every 15 minutes.
select cron.schedule('donna-junior-sweep', '11,26,41,56 * * * *', $c$
  select net.http_post(url := 'https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/junior',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from app_secrets where key='cron_secret')),
    body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 60000);
$c$);
