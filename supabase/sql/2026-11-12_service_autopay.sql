-- Autopay for repeat services (Contractor Donna and Junior Donna). Applied Nov 12 2026 (migration service_autopay). Additive only.
alter table public.recurring_jobs add column if not exists autopay jsonb;
alter table public.junior_customers add column if not exists autopay jsonb;
alter table public.junior_customers add column if not exists contact_id uuid references public.contacts(id) on delete set null;
create index if not exists recurring_jobs_autopay_token_idx on public.recurring_jobs ((autopay->>'token')) where autopay is not null;
create index if not exists junior_customers_autopay_token_idx on public.junior_customers ((autopay->>'token')) where autopay is not null;
-- cron donna-autopay-sweep: 4,19,34,49 * * * * -> POST /functions/v1/autopay {"action":"sweep"} with the x-cron-secret header
