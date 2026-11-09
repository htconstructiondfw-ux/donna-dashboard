-- Joe's Mobile Detailing demo data (Nov 9): a fuller service menu, customers with vehicles on file, past paid jobs
-- with invoices, upcoming jobs, two open estimates and more FAQ, so callers to (817) 678-0529 and the phone app have
-- realistic data. Fictional customers (555 numbers, example.com). Demo rows carry '(demo)'.
-- Account 9cfb1065-ac24-4add-a2e2-2224a76888d5 · owner/tech Joe Alvarez f47572b8-ae9a-4262-be86-65b0ae75f4c9.

-- Services (all mobile, so requires_travel). Existing: Full detail $220/3h, Interior detail $140/2h, Exterior wash & wax $80/1h.
insert into public.appointment_types (account_id, name, mode, default_duration_min, buffer_before_min, buffer_after_min, requires_travel, is_active, description, price, category, is_public)
select '9cfb1065-ac24-4add-a2e2-2224a76888d5', v.name, 'in_person', v.dur, 0, 0, true, true, v.descr, v.price, v.cat, true
from (values
 ('Maintenance wash', 45, 'Hand wash, wheels, tires dressed, windows, quick interior wipe-down. Every 2 to 4 weeks keeps a detailed car looking detailed.', '$55', 'Wash'),
 ('Paint correction (one step)', 240, 'Machine polish to remove light swirls and haze, then a sealant. Big difference on dark colors.', 'from $350', 'Paint'),
 ('Ceramic coating', 360, 'One-step correction plus a professional ceramic coating with a 2-year warranty. Includes a 24-hour cure before driving in rain.', 'from $650', 'Paint'),
 ('Headlight restoration', 30, 'Wet-sand, polish and UV-seal cloudy headlights. Both lights.', '$60', 'Add-ons'),
 ('Pet hair removal', 30, 'Add-on to an interior or full detail for heavy pet hair.', '$40', 'Add-ons'),
 ('Odor treatment', 60, 'Ozone treatment plus a deep clean of the source. Smoke, mildew, spilled milk. Add-on to an interior detail.', '$75', 'Add-ons'),
 ('Engine bay cleaning', 30, 'Degrease, rinse and dress the engine bay. Add-on.', '$50', 'Add-ons'),
 ('Boat or RV detail', 240, 'Wash, oxidation removal and wax for boats and RVs up to 30 feet. Larger by estimate.', 'from $300', 'Specialty')
) as v(name, dur, descr, price, cat)
where not exists (select 1 from public.appointment_types t where t.account_id='9cfb1065-ac24-4add-a2e2-2224a76888d5' and lower(t.name)=lower(v.name));

update public.appointment_types set category='Detail packages' where account_id='9cfb1065-ac24-4add-a2e2-2224a76888d5' and category is null and name in ('Full detail','Interior detail','Exterior wash & wax');

-- Knowledge: refresh the menu answer and add common questions.
update public.knowledge_entries set content='Maintenance wash $55 (about 45 minutes). Exterior wash and wax $80 (about 1 hour). Interior detail $140 (about 2 hours). Full detail inside and out $220 (about 3 hours). Paint correction from $350 and ceramic coating from $650 — those need a quick look at the car first, so Joe will text an estimate. Add-ons: headlight restoration $60, pet hair $40, odor treatment $75, engine bay $50. Boats and RVs from $300. Trucks, large SUVs and heavily soiled interiors add $30 to $60.', updated_at=now()
 where account_id='9cfb1065-ac24-4add-a2e2-2224a76888d5' and title='What do you offer and what does it cost?';

insert into public.knowledge_entries (account_id, source, category, title, content, approved)
select '9cfb1065-ac24-4add-a2e2-2224a76888d5', 'manual', 'FAQ', v.t, v.c, true
from (values
 ('Do I need to provide water or power?', 'No. The van carries its own water tank and generator. If you have a hose and an outlet nearby it helps on big jobs, but it is not required. Joe needs about two car lengths of space to park next to the vehicle.'),
 ('What if it rains?', 'Light rain is fine for interior work. For exterior work, wash and wax or paint correction, Joe will text you the morning of the appointment if the weather is a problem and offer the next open slot. There is no charge to move an appointment for weather.'),
 ('How long does a ceramic coating last and what do I need to do?', 'The coating Joe uses carries a 2-year warranty. Keep the car out of rain and off automatic car washes for 24 hours after it is applied, then hand wash every few weeks (the maintenance wash is made for this). Joe will text a care sheet after the job.'),
 ('Do you do fleets or multiple cars at one address?', 'Yes. Two or more vehicles at the same address on the same visit get $15 off each, and the trip fee is charged once. For company fleets Joe sets up a monthly schedule and sends one invoice.'),
 ('Can I buy a gift card?', 'Yes. Donna can take the amount and who it is for, and Joe texts a gift card link the same day. Any amount, good for a year, and it can be used toward any service.'),
 ('What does the trip fee cover?', 'The $49 trip fee covers coming out to you. It is waived whenever work is done, so you only ever pay it if Joe comes out and the job cannot happen — for example the car is not there or the wrong vehicle was booked.')
) as v(t, c)
where not exists (select 1 from public.knowledge_entries k where k.account_id='9cfb1065-ac24-4add-a2e2-2224a76888d5' and k.title=v.t);

-- Customers (vehicle on file in memory so Donna can say "the Tahoe again?").
insert into public.contacts (account_id, name, preferred_name, phone, email, list_type, source, call_count, last_call_at, memory, preferences, notes)
select '9cfb1065-ac24-4add-a2e2-2224a76888d5', v.n, v.pn, v.ph, v.em, 'normal', 'seed', v.cc, now() - (v.days||' days')::interval, v.mem, v.pr, '(demo) ' || v.addr
from (values
 ('Carla Mendes','Carla','+18175550701','carla.mendes@example.com',5,16,'Black 2022 Chevy Tahoe. Full detail every 3 months, maintenance wash in between. Two kids and a golden retriever — always needs pet hair. Parks in the driveway.','Weekday mornings; text when en route','1408 Willow Bend Dr, Mansfield, TX 76063'),
 ('Jordan Blake','Jordan','+18175550702','jblake@example.com',2,40,'Silver 2019 Honda Accord. Interior detail in September after a coffee spill. Asked about ceramic coating pricing.','Saturdays','3317 Meadow Creek Ln, Arlington, TX 76016'),
 ('Pastor Mike Owens','Mike','+18175550703','office@example.com',3,12,'Grace Community Church. Two 15-passenger Ford Transit vans, washed monthly at the church lot. Pays by church card; invoice goes to the office email.','First Monday of the month, 8 AM','2200 S Cooper St, Arlington, TX 76015'),
 ('Lydia Tran','Lydia','+18175550704','lydia.tran@example.com',1,9,'White 2024 Tesla Model Y, brand new. Booked ceramic coating; wants it done in the garage. Very particular — asked about swirl marks twice.','Garage access; prefers email receipts','5103 Harvest Hill Ct, Mansfield, TX 76063'),
 ('Ray Gutierrez','Ray','+18175550705',null,4,25,'Red 2020 Ford F-250 (work truck, always muddy) and a 2017 Mustang GT (garage queen). Truck gets a wash and interior every month; Mustang gets a wax before car shows.','After 4 PM weekdays','812 Live Oak St, Kennedale, TX 76060'),
 ('Denise Fowler','Denise','+18175550706','denise.f@example.com',2,70,'Blue 2018 Toyota Highlander. Odor treatment in August (mildew from a leaking sunroof), came out great. Mentioned her husband''s truck next.','Weekends','1920 Cedar Elm Dr, Arlington, TX 76012'),
 ('Northgate Realty — Sam Park','Sam','+18175550707','sam@example.com',3,5,'Real estate office. Keeps the listing agents'' cars clean: 4 cars at the office lot, maintenance wash every other Friday. Fleet rate. One invoice to the office.','Every other Friday, 7:30 AM, before showings','4600 Little Rd, Arlington, TX 76016'),
 ('Hector Ruiz','Hector','+18175550708',null,1,2,'Called about a 24-foot pontoon boat at Joe Pool Lake marina; wants oxidation removed before selling it. Needs an estimate.','Spanish preferred','Lynn Creek Marina, Grand Prairie, TX')
) as v(n, pn, ph, em, cc, days, mem, pr, addr)
where not exists (select 1 from public.contacts c where c.account_id='9cfb1065-ac24-4add-a2e2-2224a76888d5' and c.phone=v.ph);

-- Appointments + jobs. Past ones are done and paid (invoice attached); upcoming are scheduled.
-- Times are local Central (CST = UTC-6).
with acct as (select '9cfb1065-ac24-4add-a2e2-2224a76888d5'::uuid id), joe as (select 'f47572b8-ae9a-4262-be86-65b0ae75f4c9'::uuid id),
c as (select id, name, phone, email, regexp_replace(notes,'^\(demo\) ','') addr from public.contacts where account_id=(select id from acct) and source='seed'),
t as (select id, name, default_duration_min dur from public.appointment_types where account_id=(select id from acct)),
rows as (select * from (values
  -- past: (phone, service, day offset, local time, status, line items jsonb, total cents)
  ('+18175550701','Full detail',            -14, '09:00', 'completed', '[{"qty":1,"desc":"Full detail — Chevy Tahoe (large SUV)","kind":"service","cents":25000,"unit_cents":25000},{"qty":1,"desc":"Pet hair removal","kind":"addon","cents":4000,"unit_cents":4000},{"qty":1,"desc":"Trip fee (waived, work done)","kind":"trip_fee","cents":0,"unit_cents":4900}]', 29000),
  ('+18175550705','Interior detail',        -10, '16:30', 'completed', '[{"qty":1,"desc":"Interior detail — F-250 (heavily soiled)","kind":"service","cents":17000,"unit_cents":17000},{"qty":1,"desc":"Exterior wash & wax","kind":"addon","cents":8000,"unit_cents":8000},{"qty":1,"desc":"Trip fee (waived, work done)","kind":"trip_fee","cents":0,"unit_cents":4900}]', 25000),
  ('+18175550703','Maintenance wash',        -7, '08:00', 'completed', '[{"qty":2,"desc":"Maintenance wash — Transit van","kind":"service","cents":11000,"unit_cents":5500},{"qty":1,"desc":"Trip fee (waived, work done)","kind":"trip_fee","cents":0,"unit_cents":4900}]', 11000),
  ('+18175550707','Maintenance wash',        -3, '07:30', 'completed', '[{"qty":4,"desc":"Maintenance wash — fleet rate","kind":"service","cents":16000,"unit_cents":4000},{"qty":1,"desc":"Trip fee (waived, work done)","kind":"trip_fee","cents":0,"unit_cents":4900}]', 16000),
  ('+18175550702','Interior detail',        -45, '10:00', 'completed', '[{"qty":1,"desc":"Interior detail — Honda Accord","kind":"service","cents":14000,"unit_cents":14000},{"qty":1,"desc":"Trip fee (waived, work done)","kind":"trip_fee","cents":0,"unit_cents":4900}]', 14000),
  -- upcoming
  ('+18175550704','Ceramic coating',          2, '09:00', 'scheduled', '[{"qty":1,"desc":"Ceramic coating — Tesla Model Y (one-step correction included)","kind":"service","cents":65000,"unit_cents":65000}]', 65000),
  ('+18175550701','Maintenance wash',         4, '09:00', 'scheduled', '[{"qty":1,"desc":"Maintenance wash — Chevy Tahoe","kind":"service","cents":5500,"unit_cents":5500}]', 5500),
  ('+18175550706','Full detail',              5, '13:00', 'scheduled', '[{"qty":1,"desc":"Full detail — Toyota Highlander","kind":"service","cents":22000,"unit_cents":22000},{"qty":1,"desc":"Headlight restoration","kind":"addon","cents":6000,"unit_cents":6000}]', 28000),
  ('+18175550705','Exterior wash & wax',      6, '16:30', 'scheduled', '[{"qty":1,"desc":"Exterior wash & wax — Mustang GT (car show Saturday)","kind":"service","cents":8000,"unit_cents":8000}]', 8000),
  ('+18175550707','Maintenance wash',        11, '07:30', 'scheduled', '[{"qty":4,"desc":"Maintenance wash — fleet rate","kind":"service","cents":16000,"unit_cents":4000}]', 16000)
 ) as v(phone, svc, off, hhmm, st, lines, total)),
ins_appt as (
  insert into public.appointments (account_id, contact_id, title, starts_at, ends_at, status, notes, appointment_type_id, user_id, mode, location_address, travel_minutes_before, sync_status, source, confirmed_at)
  select (select id from acct), c.id, r.svc || ' with ' || c.name,
    (((current_date + r.off)::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago'),
    (((current_date + r.off)::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago') + (t.dur || ' minutes')::interval,
    r.st::appt_status, '(demo)', t.id, (select id from joe), 'in_person', c.addr, 30, 'skipped', 'seed',
    case when r.st='completed' then (((current_date + r.off)::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago') - interval '1 day' else null end
  from rows r join c on c.phone=r.phone join t on t.name=r.svc
  where not exists (select 1 from public.appointments a where a.account_id=(select id from acct) and a.contact_id=c.id and a.starts_at=(((current_date + r.off)::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago'))
  returning id, contact_id, title, starts_at, ends_at, status, appointment_type_id, location_address),
ins_jobs as (
  insert into public.jobs (account_id, appointment_id, contact_id, assigned_user_id, title, kind, status, priority, customer_name, customer_phone, customer_email, address, scheduled_at, lines, notes, photos, en_route_at, started_at, done_at)
  select (select id from acct), a.id, a.contact_id, (select id from joe), t.name, 'service', case when a.status='completed' then 'paid' else 'scheduled' end, 'normal',
    c.name, c.phone, c.email, a.location_address, a.starts_at, r.lines::jsonb, '(demo) ' || c.name || ' — see customer notes for the vehicle.', '[]'::jsonb,
    case when a.status='completed' then a.starts_at - interval '25 minutes' end,
    case when a.status='completed' then a.starts_at end,
    case when a.status='completed' then a.ends_at end
  from ins_appt a join c on c.id=a.contact_id join t on t.id=a.appointment_type_id
  join rows r on r.phone=c.phone and r.svc=t.name and (((current_date + r.off)::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago')=a.starts_at
  returning id, appointment_id, contact_id, customer_name, customer_phone, customer_email, address, lines, done_at, status),
numbered as (
  select j.*, r.total, row_number() over (order by j.done_at) rn,
    (select coalesce(max(nullif(regexp_replace(number,'\D','','g'),'')::int),1000) from public.invoices where account_id=(select id from acct)) base
  from ins_jobs j join c on c.id=j.contact_id join rows r on r.phone=c.phone and r.lines::jsonb=j.lines
  where j.status='paid'),
ins_inv as (
  insert into public.invoices (account_id, contact_id, appointment_id, job_id, number, status, currency, lines, subtotal_cents, tax_cents, total_cents, notes, customer_name, customer_phone, customer_email, service_address, pay_token, sent_at, sent_channel, paid_at, paid_method, paid_note, created_by, created_at)
  select (select id from acct), n.contact_id, n.appointment_id, n.id, 'INV-' || (n.base + n.rn), 'paid', 'usd', n.lines, n.total, 0, n.total, '(demo)', n.customer_name, n.customer_phone, n.customer_email, n.address,
    encode(gen_random_bytes(12),'hex'), n.done_at + interval '5 minutes', 'sms', n.done_at + interval '38 minutes', 'card', 'Demo payment (no Stripe record)', (select id from joe), n.done_at + interval '5 minutes'
  from numbered n
  returning id, job_id)
update public.jobs j set invoice_id=i.id from ins_inv i where j.id=i.job_id;

-- Two open estimates: one sent and waiting, one that needs Joe's review before it goes out.
with acct as (select '9cfb1065-ac24-4add-a2e2-2224a76888d5'::uuid id), joe as (select 'f47572b8-ae9a-4262-be86-65b0ae75f4c9'::uuid id),
base as (select count(*) n from public.estimates where account_id=(select id from acct)),
c as (select id, name, phone, email, regexp_replace(notes,'^\(demo\) ','') addr from public.contacts where account_id=(select id from acct) and source='seed')
insert into public.estimates (account_id, contact_id, number, status, lines, total_cents, notes, customer_name, customer_phone, customer_email, service_address, approve_token, valid_days, sent_at, expires_at, created_by, created_at)
select (select id from acct), c.id, 'EST-' || (1000 + (select n from base) + v.i), v.st, v.lines::jsonb, v.total, '(demo) ' || v.note, c.name, c.phone, c.email, c.addr,
  encode(gen_random_bytes(12),'hex'), 30, case when v.st='sent' then now() - interval '2 days' end, case when v.st='sent' then now() + interval '28 days' end, (select id from joe), now() - interval '2 days'
from (values
 (1,'+18175550702','sent','[{"qty":1,"desc":"Ceramic coating — Honda Accord, includes one-step paint correction","kind":"service","cents":65000,"unit_cents":65000},{"qty":1,"desc":"Headlight restoration","kind":"optional","cents":6000,"unit_cents":6000}]',65000,'Jordan asked for ceramic pricing after the interior detail. Garage available.'),
 (2,'+18175550708','review','[{"qty":1,"desc":"Boat detail — 24 ft pontoon, oxidation removal and wax","kind":"service","cents":42000,"unit_cents":42000},{"qty":1,"desc":"Interior vinyl clean and protect","kind":"optional","cents":9000,"unit_cents":9000}]',42000,'Needs Joe to confirm the marina allows washing at the slip before this goes out.')
) as v(i, phone, st, lines, total, note)
join c on c.phone=v.phone
where not exists (select 1 from public.estimates e where e.account_id=(select id from acct) and e.contact_id=c.id and e.status in ('sent','review'));
