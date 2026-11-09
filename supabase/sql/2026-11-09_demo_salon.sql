-- Test Salon demo data (Nov 9): a fuller service menu, more approved FAQ, clients with history, and a busier calendar
-- so callers to (817) 506-4765 can book / reschedule / ask prices against realistic data. Demo rows are tagged
-- "(demo)" in notes/source so they can be cleared later. Account 6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3.
-- Stylists: Mai Nguyen (owner) 1164c02b-c382-4d87-8a4a-36fadf299a4f, An Wong 68a16848-b32e-4bc6-bad6-240355814a28.

-- Services the FAQ already promises but the menu didn't have.
insert into public.appointment_types (account_id, name, mode, default_duration_min, buffer_before_min, buffer_after_min, requires_travel, is_active, description, price, category, is_public)
select '6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3', v.name, 'in_person', v.dur, 0, 5, false, true, v.descr, v.price, v.cat, true
from (values
 ('Men''s haircut', 30, 'Clipper or scissor cut with a neck clean-up.', '$30', 'Hair'),
 ('Kids cut (12 and under)', 30, 'A quick, patient cut for kids.', '$25', 'Hair'),
 ('Root touch-up', 90, 'Single-process color on the regrowth, with gloss.', '$75', 'Color'),
 ('Balayage', 180, 'Hand-painted highlights for a natural, lived-in look, with toner.', 'from $185', 'Color'),
 ('Deep conditioning treatment', 30, 'Intensive mask with scalp massage. Great as an add-on to a cut or color.', '$35', 'Treatments'),
 ('Special-occasion styling', 60, 'Updo or formal style for weddings, proms and events.', '$85', 'Styling'),
 ('Color consultation', 15, 'A free 15-minute chat about a color change before you book it.', 'Free', 'Color')
) as v(name, dur, descr, price, cat)
where not exists (select 1 from public.appointment_types t where t.account_id='6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3' and lower(t.name)=lower(v.name));

-- A current special.
insert into public.appointment_types (account_id, name, mode, default_duration_min, buffer_after_min, is_active, description, price, category, is_special, special_starts, special_ends, is_public)
select '6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3', 'Holiday gloss and blowout', 'in_person', 60, 5, true, 'A clear or tinted gloss for shine plus a full blowout. November and December only.', '$70', 'Specials', true, '2026-11-01', '2026-12-31', true
where not exists (select 1 from public.appointment_types t where t.account_id='6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3' and t.name='Holiday gloss and blowout');

-- More approved knowledge.
insert into public.knowledge_entries (account_id, source, category, title, content, approved)
select '6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3', 'manual', 'FAQ', v.t, v.c, true
from (values
 ('What products do you use and sell?', 'We color with Redken Shades EQ and use Kevin Murphy and Olaplex for care and styling. Retail products are available at the front desk and your stylist can recommend what fits your hair.'),
 ('Do you sell gift cards?', 'Yes. Gift cards are available in any amount at the salon, or we can email one to you. They never expire and work for services and products.'),
 ('What if I am running late?', 'Call or text us. We hold your spot for 15 minutes. After that we may need to shorten the service or move you to the next opening so the stylist stays on time for the next client.'),
 ('How do I pay?', 'We take all major cards, Apple Pay, Google Pay and cash. Tips can be added on the card or given in cash.'),
 ('Do you do bridal or event hair?', 'Yes. We do updos and formal styling in the salon, and we can book a bridal party as a block on a Saturday morning. Please book bridal parties at least three weeks ahead and ask for a trial run.'),
 ('How long does color take and do I need a consultation?', 'Single-process color is about two hours, highlights and balayage about three. If you are going more than two shades lighter or have had box color or a keratin treatment, book a free 15-minute color consultation first so we can plan it and give you an accurate price.'),
 ('Can I bring my kids?', 'Kids are welcome for their own appointments, and we have a kids cut for 12 and under. For your own appointment we ask that children have someone to sit with them, since color and cutting areas are not kid-safe.'),
 ('Is there a waitlist?', 'Yes. If the time you want is full, ask to be put on the waitlist and we will text you the moment something opens up.')
) as v(t, c)
where not exists (select 1 from public.knowledge_entries k where k.account_id='6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3' and k.title=v.t);

-- Clients with history (fictional numbers in the 555 range so nobody real gets a text).
insert into public.contacts (account_id, name, preferred_name, phone, email, list_type, source, call_count, last_call_at, memory, allergies, formulas, preferences, stylist_notes, notes)
select '6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3', v.n, v.pn, v.ph, v.em, 'normal', 'seed', v.cc, now() - (v.days||' days')::interval, v.mem, v.al, v.fo, v.pr, v.sn, '(demo)'
from (values
 ('Danielle Carter','Dani','+18175550141','dani.carter@example.com',4,12,'Regular every 6 weeks with An. Usually a haircut and style. Likes to come in Saturday mornings. Has two kids, sometimes books a kids cut at the same time.',null,null,'Saturday mornings; An','Fine, shoulder-length; layers, not too short.'),
 ('Marcus Bell','Marcus','+18175550152','marcus.bell@example.com',2,30,'Men''s haircut every 3 to 4 weeks, no preference on stylist. Asked once about beard trims (we don''t do them).',null,null,'Any stylist; after 5 PM weekdays','#2 on the sides, scissor on top.'),
 ('Alyssa Romero','Alyssa','+18175550163','alyssa.romero@example.com',5,45,'Balayage client with Mai, every 10 to 12 weeks. Last visit September. Very particular about tone — wants it ash, never warm.','None','Balayage: lightener 20 vol, toner Shades EQ 9V + 9T 1:1 for 15 min','Mai; afternoons','Ash balayage, keep root shadow. Bring to 9/10 level.'),
 ('Tran Le','Tran','+18175550174',null,1,60,'New client in September, had a blowout before a wedding. Said she would come back for color.',null,null,null,null),
 ('Gabriela Santos','Gabi','+18175550185','gabi.santos@example.com',3,20,'Root touch-up every 5 weeks with Mai. Sensitive scalp — uses the gentle developer.','Sensitive scalp; no ammonia','Root touch-up: Shades EQ 5N + 5NB 1:1, 10 vol','Mai; Tuesdays or Wednesdays','Gentle developer only. Scalp sensitive.'),
 ('Kevin Okafor','Kevin','+18175550196','kevin.okafor@example.com',2,8,'Haircut with An every 4 weeks. Booked a deep conditioning add-on last time and liked it.',null,null,'An; lunchtime','Textured hair, shape with scissors, no clippers.'),
 ('Linda Park','Linda','+18175550107',null,6,38,'Long-time client (since before Donna). Color and cut every 8 weeks with Mai. Prefers phone over text.','None','Single process: Shades EQ 6N + 6NB, 10 vol','Mai; Thursdays','Covers gray fully; likes a blunt bob.'),
 ('Brianna Hughes','Bri','+18175550118','bri.hughes@example.com',1,3,'Called last week about balayage pricing and a color consultation; hasn''t booked yet.',null,null,null,null)
) as v(n, pn, ph, em, cc, days, mem, al, fo, pr, sn)
where not exists (select 1 from public.contacts c where c.account_id='6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3' and c.phone=v.ph);

-- Past and upcoming appointments for those clients. Times are America/Chicago; stored as UTC (CST = UTC-6).
-- Helper: next occurrence of a weekday on/after today, at a given local hour.
with sal as (select '6e0f8e3a-daff-43c0-b6e1-87276ba6dbb3'::uuid id),
mai as (select '1164c02b-c382-4d87-8a4a-36fadf299a4f'::uuid id), an as (select '68a16848-b32e-4bc6-bad6-240355814a28'::uuid id),
c as (select phone, id, name from public.contacts where account_id=(select id from sal)),
t as (select name, id, default_duration_min dur from public.appointment_types where account_id=(select id from sal)),
rows as (
 select * from (values
  -- past (completed)
  ('+18175550141','Haircut and style', (select id from an),  (current_date - 40) , '10:00', 'completed'),
  ('+18175550163','Balayage',          (select id from mai), (current_date - 52) , '13:00', 'completed'),
  ('+18175550185','Root touch-up',     (select id from mai), (current_date - 34) , '09:30', 'completed'),
  ('+18175550196','Haircut',           (select id from an),  (current_date - 29) , '12:00', 'completed'),
  ('+18175550107','Color',             (select id from mai), (current_date - 55) , '14:00', 'completed'),
  ('+18175550152','Men''s haircut',    (select id from an),  (current_date - 26) , '17:00', 'completed'),
  ('+18175550174','Blowout',           (select id from mai), (current_date - 61) , '15:00', 'completed'),
  -- upcoming (scheduled) — spread across the next two weeks on open days (Tue–Sat)
  ('+18175550141','Haircut and style', (select id from an),  (current_date + 5)  , '10:00', 'scheduled'),
  ('+18175550185','Root touch-up',     (select id from mai), (current_date + 2)  , '09:30', 'scheduled'),
  ('+18175550196','Haircut',           (select id from an),  (current_date + 3)  , '12:00', 'scheduled'),
  ('+18175550107','Color',             (select id from mai), (current_date + 4)  , '14:00', 'scheduled'),
  ('+18175550152','Men''s haircut',    (select id from an),  (current_date + 4)  , '17:00', 'scheduled'),
  ('+18175550163','Balayage',          (select id from mai), (current_date + 9)  , '13:00', 'scheduled'),
  ('+18175550141','Kids cut (12 and under)', (select id from an), (current_date + 5), '11:00', 'scheduled'),
  ('+18175550196','Deep conditioning treatment', (select id from an), (current_date + 3), '12:45', 'scheduled'),
  ('+18175550107','Haircut',           (select id from mai), (current_date + 11) , '10:00', 'scheduled')
 ) as v(phone, svc, user_id, d, hhmm, st)
)
insert into public.appointments (account_id, contact_id, title, starts_at, ends_at, status, notes, appointment_type_id, user_id, mode, sync_status, source)
select (select id from sal), c.id, r.svc || ' with ' || (case when r.user_id=(select id from mai) then 'Mai' else 'An' end),
  ((r.d::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago'),
  ((r.d::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago') + (t.dur || ' minutes')::interval,
  r.st::appt_status, '(demo)', t.id, r.user_id, 'in_person', 'skipped', 'seed'
from rows r join c on c.phone=r.phone join t on t.name=r.svc
-- skip Sundays/Mondays (closed) by nudging to Tuesday
where extract(dow from r.d) not in (0,1)
  and not exists (select 1 from public.appointments a where a.account_id=(select id from sal) and a.contact_id=c.id and a.starts_at=((r.d::text || ' ' || r.hhmm)::timestamp at time zone 'America/Chicago'));
