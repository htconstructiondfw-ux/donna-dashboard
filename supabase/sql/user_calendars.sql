-- Per-person calendars (applied as migrations user_calendars, user_calendars_nonce_fix, user_calendar_disconnect_and_cron).
-- Each team member can connect their own Google / Outlook calendar. Kept separate from calendar_connections
-- (the company calendar) so nothing that reads the company calendar changes.
create table if not exists public.user_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  external_account text, calendar_id text, access_token text, refresh_token text, token_expires_at timestamptz,
  status text not null default 'connected', last_error text, last_pulled_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id)
);
alter table public.user_calendar_connections enable row level security; -- service role only (tokens)

-- One-time OAuth state: the browser gets a random nonce, the callback learns account + person from it.
create table if not exists public.oauth_states (
  nonce text primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  provider text not null,
  scope text not null check (scope in ('company','user')),
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;

-- Busy time pulled from a person's own calendar lives in calendar_blocks so every booking path respects it.
alter table public.calendar_blocks add column if not exists source text not null default 'manual';
create index if not exists calendar_blocks_user_source_idx on public.calendar_blocks(user_id, source);

-- Mirror of each appointment on the assigned person's own calendar.
alter table public.appointments add column if not exists user_event_id text;
alter table public.appointments add column if not exists user_event_provider text;
alter table public.appointments add column if not exists user_event_user uuid;
alter table public.appointments add column if not exists user_synced_start timestamptz;
alter table public.appointments add column if not exists user_synced_end timestamptz;
alter table public.appointments add column if not exists user_sync_status text;
create index if not exists appointments_user_event_idx on public.appointments(user_id) where user_event_id is not null;

create or replace function public.donna_calendar_oauth_start(p_provider text, p_scope text default 'company')
returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_acct uuid; v_role text; v_active boolean; v_nonce text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_provider not in ('google','microsoft') then raise exception 'bad provider'; end if;
  if p_scope not in ('company','user') then raise exception 'bad scope'; end if;
  select account_id, role, coalesce(is_active,true) into v_acct, v_role, v_active from users where id = v_uid;
  if v_acct is null or not v_active then raise exception 'no account'; end if;
  if p_scope = 'company' and v_role not in ('owner','admin') then raise exception 'managers only'; end if;
  delete from oauth_states where created_at < now() - interval '30 minutes';
  v_nonce := encode(extensions.gen_random_bytes(24), 'hex');
  insert into oauth_states(nonce, account_id, user_id, provider, scope) values (v_nonce, v_acct, v_uid, p_provider, p_scope);
  return v_nonce;
end $$;
revoke all on function public.donna_calendar_oauth_start(text,text) from public, anon;
grant execute on function public.donna_calendar_oauth_start(text,text) to authenticated;

create or replace function public.donna_my_calendar()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('provider', provider, 'email', external_account, 'status', status, 'last_error', last_error, 'last_pulled_at', last_pulled_at)
    from user_calendar_connections where user_id = auth.uid()), '{}'::jsonb);
$$;
revoke all on function public.donna_my_calendar() from public, anon;
grant execute on function public.donna_my_calendar() to authenticated;

create or replace function public.donna_my_calendar_disconnect()
returns void language sql security definer set search_path = public as $$
  delete from calendar_blocks where user_id = auth.uid() and source = 'calendar';
  update appointments set user_event_id = null, user_event_user = null, user_sync_status = null where user_event_user = auth.uid();
  delete from user_calendar_connections where user_id = auth.uid();
$$;
revoke all on function public.donna_my_calendar_disconnect() from public, anon;
grant execute on function public.donna_my_calendar_disconnect() to authenticated;

create or replace function public.donna_team_calendars()
returns table(user_id uuid, provider text, email text, status text)
language sql security definer set search_path = public as $$
  select c.user_id, c.provider, c.external_account, c.status from user_calendar_connections c
   where c.account_id = current_account_id() and is_account_admin();
$$;
revoke all on function public.donna_team_calendars() from public, anon;
grant execute on function public.donna_team_calendars() to authenticated;

-- Sweep every 2 minutes (push appointments, pull busy time every 10).
select cron.schedule('donna-user-calendar-sweep', '*/2 * * * *', $c$
  select net.http_post(
    url := 'https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/user-calendar',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from app_secrets where key='cron_secret')),
    body := '{"action":"sweep"}'::jsonb);
$c$);
