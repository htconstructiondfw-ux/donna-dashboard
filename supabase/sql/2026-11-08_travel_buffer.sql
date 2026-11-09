-- Contractors: leave drive time between back-to-back jobs (settings.contractor.travel_buffer_min, default 30 min).
-- Applied in donna_is_slot_open_user (and therefore donna_is_slot_open) for accounts with industry = 'contractor'.
CREATE OR REPLACE FUNCTION public.donna_is_slot_open_user(p_account_id uuid, p_user_id uuid, p_start timestamp with time zone, p_dur_min integer DEFAULT 30, p_tz text DEFAULT 'America/Chicago'::text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  with loc as (select (p_start at time zone p_tz) as lt),
  buf as (
    select case when (ac.industry = 'contractor' or ac.settings->>'industry' = 'contractor')
                then coalesce(nullif(ac.settings->'contractor'->>'travel_buffer_min','')::int, 30) else 0 end as mins
      from accounts ac where ac.id = p_account_id),
  urules as (
    select 1 from availability_rules r, loc
     where r.user_id = p_user_id and r.rule_type = 'bookable'
       and r.day_of_week = extract(dow from loc.lt)::int
       and loc.lt::time >= r.start_time and (loc.lt::time + make_interval(mins => p_dur_min)) <= r.end_time)
  select p_start > now()
    and exists (select 1 from urules)
    and not exists (
      select 1 from calendar_blocks b
       where b.account_id = p_account_id and (b.user_id = p_user_id or b.user_id is null)
         and p_start < b.ends_at and (p_start + make_interval(mins => p_dur_min)) > b.starts_at)
    and not exists (
      select 1 from appointments a, buf
       where a.user_id = p_user_id and a.status in ('scheduled','confirmed')
         and p_start < a.starts_at + make_interval(mins => coalesce(a.active_minutes,
               greatest(1, round(extract(epoch from (coalesce(a.ends_at, a.starts_at + make_interval(mins => 30)) - a.starts_at)) / 60))::int) + coalesce(buf.mins,0))
         and (p_start + make_interval(mins => p_dur_min + coalesce(buf.mins,0))) > a.starts_at);
$function$;
