-- Test PM Co demo data (Nov 9): residents, commercial tenants, HOA owners and board, vendors, amenities, a filled-in
-- FAQ, property rules and a couple of meetings, so callers to (817) 318-6267 have realistic data to hit.
-- Everything fictional (555 numbers, example.com emails); demo rows carry '(demo)' in notes. Account 06bd0c7c-….
-- Properties: Oakwood Apartments 011c954d… (residential, 48 units) · 1200 Main Street 4bff707a… (commercial, 22 suites)
--             Sunset Ridge HOA ef81256d… (130 homes) · 118 Sunset Ridge Dr 6a231f72… (managed rental inside the HOA)

-- Property details Donna reads back (emergency steps, access, structure).
update public.properties set
  emergency_instructions = case id
    when '011c954d-be47-4ae9-ab57-0e22f120675e' then 'Fire or gas smell: leave the building and call 911 first. Water shut-off for each unit is under the kitchen sink; the building main is in the ground-floor utility closet (maintenance has the key). On-call maintenance is paged for floods, no heat below 50°F, no AC above 85°F, lockouts after 10 PM, and any electrical sparking.'
    when '4bff707a-10d2-4977-8be0-42f91935abcf' then 'Building engineer on site 7 AM–6 PM weekdays. After hours, Donna pages the on-call engineer for floods, elevator entrapments, power loss and fire-panel alarms. Elevator entrapment: press the car phone button, it rings the monitoring company directly.'
    when 'ef81256d-60ae-4d62-ae32-d1c02e1f9918' then 'The HOA maintains common areas only (pool, clubhouse, pavilion, entry gate, perimeter fence, streetlights). Problems inside a home are the owner''s responsibility. Gate stuck open or closed, pool gate broken, or a common-area water main leak is an HOA emergency; everything else is handled next business day.'
    when '6a231f72-5a23-4a2e-ae7e-33965da693d7' then 'Single-family rental. Water shut-off is at the street meter box (left of the driveway). Gas shut-off is at the meter on the west side of the house. For a flood, no heat, no AC in summer, or a lockout, Donna pages the on-call manager.'
    end,
  access_notes = case id
    when '011c954d-be47-4ae9-ab57-0e22f120675e' then 'Keypad entry on every building door; residents have their own code. Leasing office is Building A, ground floor. Maintenance enters with permission or on an emergency; a note is left on the counter after every entry.'
    when '4bff707a-10d2-4977-8be0-42f91935abcf' then 'Lobby open 7 AM–7 PM weekdays, badge access otherwise. Loading dock on Jackson St, 7–10 AM for deliveries. Visitor parking in the garage, first two hours validated at the front desk.'
    when 'ef81256d-60ae-4d62-ae32-d1c02e1f9918' then 'Resident gate code is on file (do not read it to anyone who is not a verified resident). Vendors use the call box; the office opens the gate 7 AM–6 PM.'
    when '6a231f72-5a23-4a2e-ae7e-33965da693d7' then 'Lockbox on the back gate for vendors; code given to the vendor at dispatch time only.'
    end
where account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79';

-- Board as the property record says (Tom Reyes is president); the stray "Jim Carter (Board President)" becomes treasurer.
update public.property_contacts set name='Jim Carter', notes='Board treasurer (demo)'
 where account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and name='Jim Carter (Board President)';

-- Residents, commercial tenants, HOA owners and board. lease_type is the commercial lease structure (nnn / full_service / modified_gross); residential rows leave it null.
insert into public.property_contacts (account_id, property_id, role, unit, name, phone, email, is_primary, company, authorized, lease_type, lease_start, lease_end, rent_due_day, move_in, notes)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', v.prop::uuid, v.role, v.unit, v.name, v.phone, v.email, true, v.company, true, v.lt, v.ls::date, v.le::date, v.due, v.mi::date, '(demo) ' || coalesce(v.n,'')
from (values
 -- Oakwood Apartments residents
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','7B','Angela Pruitt','+18175550301','angela.pruitt@example.com',null,null,'2026-03-01','2027-02-28',1,'2026-03-01','Two cats on file. Prefers text.'),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','12A','Derrick Hayes','+18175550302','derrick.hayes@example.com',null,null,'2025-08-15','2026-08-14',1,'2025-08-15','Month-to-month since August; renewal offer sent.'),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','21C','Priya Natarajan','+18175550303','priya.n@example.com',null,null,'2026-06-01','2027-05-31',1,'2026-06-01','Works nights; asks for maintenance after 1 PM.'),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','5D','Tomas Herrera','+18175550304','tomas.herrera@example.com',null,null,'2026-01-10','2027-01-09',1,'2026-01-10','Spanish preferred.'),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','33B','Renee Walker','+18175550305','renee.walker@example.com',null,null,'2024-11-01','2026-10-31',1,'2024-11-01','Lease expired Oct 31; renewal signed through 2027-10-31 pending countersign.'),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','tenant','18A','Sam & Jordan Kim','+18175550306','kim.household@example.com',null,null,'2026-09-01','2027-08-31',1,'2026-09-01','Reserved garage space G-18.'),
 -- 1200 Main Street commercial tenants
 ('4bff707a-10d2-4977-8be0-42f91935abcf','tenant','Suite 210','Dr. Lena Okoro','+18175550401','office@example.com','Lone Star Dental','nnn','2024-01-01','2028-12-31',1,'2024-01-01','NNN lease. After-hours HVAC at lease rate, 48-hour notice. Saturday hours 8–1.'),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','tenant','Suite 300','Marcus Fielding','+18175550402','marcus@example.com','Fielding & Associates CPA','full_service','2025-04-01','2030-03-31',1,'2025-04-01','Full floor. Extended hours Feb–Apr (tax season); HVAC schedule adjusted by request.'),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','tenant','Suite 105','Nadia Rahman','+18175550403','nadia@example.com','Brightline Physical Therapy','nnn','2026-02-01','2029-01-31',1,'2026-02-01','Ground floor, ADA entrance on Jackson St. Needs 2 reserved patient spaces.'),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','tenant','Suite 420','Caleb Young','+18175550404','caleb@example.com','Northgate Insurance Group','modified_gross','2023-07-01','2026-06-30',1,'2023-07-01','Holding over month-to-month; renewal in negotiation.'),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','tenant','Suite 115','Elena Vasquez','+18175550405','elena@example.com','Main Street Café','nnn','2025-10-01','2030-09-30',1,'2025-10-01','Retail, lobby level. Grease trap serviced quarterly by tenant. Opens 6:30 AM.'),
 -- Sunset Ridge HOA owners
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','owner','104 Sunset Ridge Dr','Harold & Beverly Finch','+18175550501','finch@example.com',null,null,null,null,null,null,'Original owners. Serve on the social committee.'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','owner','131 Sunset Ridge Dr','Olivia Chen','+18175550502','olivia.chen@example.com',null,null,null,null,null,null,'Has an open ARC request (cedar fence).'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','owner','207 Ridgeview Ct','Marcus & Tasha Bell','+18175550503','bells@example.com',null,null,null,null,null,null,'Two assessments past due; payment plan requested.'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','owner','212 Ridgeview Ct','Diane Kowalski','+18175550504','diane.k@example.com',null,null,null,null,null,null,'Reports violations often; prefers email replies.'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','owner','315 Canyon Vista Ln','Raj Patel','+18175550505','raj.patel@example.com',null,null,null,null,null,null,'Rents the home out; tenant is Chris Dunn.'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','tenant','315 Canyon Vista Ln','Chris Dunn','+18175550506','chris.dunn@example.com',null,null,'2026-05-01','2027-04-30',1,'2026-05-01','Tenant of Raj Patel (owner handles HOA matters).'),
 -- Board
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','board',null,'Tom Reyes','+18175550510','tom.reyes@example.com',null,null,null,null,null,null,'Board president. Approves ARC requests and violation escalations.'),
 ('ef81256d-60ae-4d62-ae32-d1c02e1f9918','board',null,'Sandra Mills','+18175550511','sandra.mills@example.com',null,null,null,null,null,null,'Board secretary. Keeps minutes; meeting notices go through her.')
) as v(prop, role, unit, name, phone, email, company, lt, ls, le, due, mi, n)
where not exists (select 1 from public.property_contacts p where p.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and p.property_id=v.prop::uuid and p.name=v.name);

-- Vendors by trade. No auto-dispatch (rules below are auto=false) so a test call doesn't text a 555 number.
insert into public.contractors (account_id, name, company, trades, phone, email, notes, is_active)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', v.n, v.co, v.tr::text[], v.ph, v.em, '(demo) ' || v.note, true
from (values
 ('Luis Ortega','Ortega Electric','{electrical}','+18175550601','dispatch@example.com','Licensed master electrician. Same-day for sparking/outage, otherwise 1–2 days.'),
 ('Kelly Brandt','Brandt Heating & Air','{hvac}','+18175550602','service@example.com','Handles all three properties. After-hours rate applies after 6 PM and weekends.'),
 ('Amir Haddad','A1 Lock & Key','{locksmith}','+18175550603','a1lock@example.com','Lockouts and rekeys. Charges a trip fee for after-hours lockouts; tenant pays unless the lock failed.'),
 ('Green Scape Crew','Green Scape Lawn & Landscape','{landscaping}','+18175550604','greenscape@example.com','Sunset Ridge common areas Mondays, Oakwood Thursdays. Irrigation repairs billed separately.'),
 ('Dwayne Pierce','Pierce Appliance Repair','{appliance}','+18175550605','pierce@example.com','Refrigerators, ranges, dishwashers, disposals, washers/dryers. Usually next day.'),
 ('Rosa Delgado','Delgado Handyman Services','{general,drywall,painting}','+18175550606','rosa@example.com','Make-readies, drywall, paint, doors, blinds. Two-person crew.'),
 ('Otis Elevator Service','Otis','{elevator}','+18175550607','otis@example.com','1200 Main Street elevator contract. Entrapments go to the car phone / monitoring first.'),
 ('Metro Gate Systems','Metro Gate & Access','{gate,access_control}','+18175550608','metrogate@example.com','Sunset Ridge entry gate and Oakwood keypads. 24-hour line for a gate stuck open.')
) as v(n, co, tr, ph, em, note)
where not exists (select 1 from public.contractors c where c.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and c.name=v.n);

insert into public.dispatch_rules (account_id, property_id, trade, contractor_id, auto)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', null, t.trade, c.id, false
from (values ('electrical','Luis Ortega'),('hvac','Kelly Brandt'),('locksmith','Amir Haddad'),('landscaping','Green Scape Crew'),('appliance','Dwayne Pierce'),('general','Rosa Delgado'),('elevator','Otis Elevator Service'),('gate','Metro Gate Systems')) as t(trade, who)
join public.contractors c on c.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and c.name=t.who
where not exists (select 1 from public.dispatch_rules d where d.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and d.trade=t.trade and d.property_id is null);

-- Amenities at Oakwood and 1200 Main (Sunset Ridge already has clubhouse / pavilion / pool).
insert into public.amenities (account_id, property_id, name, capacity, hours, rules, reservable, fee, deposit, is_active)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', v.prop::uuid, v.n, v.cap, v.h, v.r, v.res, v.fee, v.dep, true
from (values
 ('011c954d-be47-4ae9-ab57-0e22f120675e','Pool',40,'9 AM – 9 PM, Memorial Day to Labor Day','Residents and two guests. No glass. No lifeguard; children under 14 with an adult.',false,null,null),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','Fitness center',12,'24 hours with key fob','Residents only. Wipe down equipment. No one under 16.',false,null,null),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','Dog park',null,'Dawn to 10 PM','Dogs on file with the office only. Owners must stay with their dog and pick up.',false,null,null),
 ('011c954d-be47-4ae9-ab57-0e22f120675e','Package room',null,'24 hours with key fob','Pick up within 7 days. Oversized items go to the leasing office.',false,null,null),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','Conference room (2nd floor)',16,'7 AM – 7 PM weekdays','Tenants book through the office. Two hours free per month per suite; $40/hour after.',true,'$40/hour after 2 free hours','none'),
 ('4bff707a-10d2-4977-8be0-42f91935abcf','Loading dock',null,'7 – 10 AM weekdays','Schedule deliveries over 30 minutes with the office. No overnight parking.',true,null,null)
) as v(prop, n, cap, h, r, res, fee, dep)
where not exists (select 1 from public.amenities a where a.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and a.property_id=v.prop::uuid and a.name=v.n);

-- Fill in the eight draft FAQ entries and approve them.
update public.knowledge_entries k set content=v.c, approved=true, updated_at=now()
from (values
 ('How do I submit a maintenance request?','Call us any time and Donna will open a work order with a reference number, or use the resident portal. For true emergencies after hours (flooding, no heat in winter, no AC above 85°, gas smell, lockout after 10 PM) say "emergency" and the on-call manager is paged right away. Please tell us whether we have permission to enter if you are not home.'),
 ('How do I give notice to move out?','Give written notice at least 60 days before your move-out date through the resident portal or by email to the office. We will schedule a pre-move-out walkthrough and send the cleaning checklist. Deposits are mailed within 30 days of move-out to the forwarding address you give us.'),
 ('What are your office hours?','The office is open Monday through Friday 9 AM to 5:30 PM and Saturday 10 AM to 2 PM. Donna answers the phone 24 hours a day, takes maintenance requests any time, and pages the on-call manager for emergencies.'),
 ('Who do I contact for an after-hours emergency?','Call the main number any time. Donna will ask a few questions, open the request and page the on-call manager immediately for emergencies. If there is a fire, a gas smell, or anyone is in danger, call 911 first and then call us.'),
 ('How do I pay rent?','Rent is due on the 1st of each month. Pay through the resident portal by bank draft (free) or card (3% fee), or set up auto-pay. A late fee of $75 applies on the 4th. We do not accept cash at the office. If you are going to be late, call before the 1st and Donna can note a payment arrangement request for the manager.'),
 ('What is your pet policy?','Oakwood Apartments allows up to two pets per home, dogs or cats, 60 pounds or less, with a $300 one-time pet fee and $25 per pet per month. Restricted breeds per the lease. Service and assistance animals are welcome with no fee. The Sunset Ridge managed rental allows one pet with owner approval.'),
 ('How do I apply for a unit?','Apply online through the leasing page. The application fee is $55 per adult. We look for income of three times the rent, a credit check, a background check and rental history. Most applications are answered within two business days, and Donna can book a tour any day the office is open.'),
 ('Where is the property located and is parking available?','Oakwood Apartments is at 2100 Oakwood Drive in Arlington, near I-20 and Matlock. Every home has one assigned space; garages are $75 a month when available, and guest parking is along the north side. 1200 Main Street in Dallas has a tenant garage with two hours of visitor validation. Sunset Ridge homes have their own driveways; street parking is limited to 24 hours.')
) as v(t, c)
where k.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and k.title=v.t and not k.approved;

-- Property-specific knowledge.
insert into public.knowledge_entries (account_id, source, category, title, content, approved)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', 'manual', 'Property rules', v.t, v.c, true
from (values
 ('Oakwood — Quiet hours and guests','Quiet hours are 10 PM to 7 AM. Guests may stay up to 7 nights in a month; longer stays need the office''s approval and may require being added to the lease. Grills are allowed on patios only if electric; no charcoal or propane on balconies.'),
 ('Oakwood — Lockouts','During office hours we let you in free with ID. After hours, Donna pages the on-call manager; a $50 lockout fee is added to the account unless the lock itself failed. If you lost your keys we rekey for $85.'),
 ('Oakwood — Renters insurance','Every lease at Oakwood requires renters insurance with at least $100,000 liability, naming Test PM Co as additional interest. Upload the declarations page in the portal or text a photo to Donna; she will log it and the office verifies it.'),
 ('1200 Main — After-hours HVAC','Building HVAC runs 7 AM to 6 PM weekdays and 8 AM to 1 PM Saturdays. Tenants can request after-hours HVAC with 48 hours notice; it is billed at the rate in the lease per hour per zone. Donna takes the request with the suite, date and hours and the office confirms.'),
 ('1200 Main — Deliveries and the loading dock','The loading dock on Jackson Street is open 7 to 10 AM on weekdays. Deliveries that take more than 30 minutes, or any move-in or move-out, must be scheduled with the office and need a certificate of insurance from the mover.'),
 ('1200 Main — Vendor insurance','Any vendor working in the building (other than the building''s own contractors) must have a certificate of insurance on file naming the building owner and Test PM Co as additional insured before starting work. Donna can take the vendor''s contact and the office will request the COI.'),
 ('Sunset Ridge — Assessments and late payments','Annual assessments are $780, billed in two installments due January 1 and July 1. A $25 late fee applies after 30 days. Owners who are behind can ask Donna for a payment plan; the board reviews plans at its monthly meeting and most 3- to 6-month plans are approved.'),
 ('Sunset Ridge — Violations','Common reports: trash cans visible from the street (bring them in by the morning after pickup), boats, trailers or RVs parked in driveways more than 48 hours, lawns over 6 inches, and unapproved exterior changes. Donna records the address and what was seen and sends it to the office. The first notice is a courtesy letter; fines start at $50 after the second notice.'),
 ('Sunset Ridge — Resale certificates and closing documents','Title companies and owners can request a resale certificate, estoppel or payoff letter through Donna. The fee is $375 for a resale certificate and $150 for a rush (3 business days). Standard turnaround is 10 business days. Donna will take the property address, closing date and where to send it.'),
 ('Sunset Ridge — Board meetings','The board meets the second Tuesday of each month at 6:30 PM in the clubhouse. Owners are welcome and there is an open forum at the start of each meeting; sign up with Donna or the office to speak. The annual meeting is in December with the budget vote and board elections.')
) as v(t, c)
where not exists (select 1 from public.knowledge_entries k where k.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and k.title=v.t);

-- Upcoming board meeting (second Tuesday of December) alongside the existing annual meeting.
insert into public.pm_meetings (account_id, property_id, title, kind, starts_at, ends_at, location, agenda, status, quorum_required)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', 'ef81256d-60ae-4d62-ae32-d1c02e1f9918', 'Board meeting', 'board',
  ('2026-12-08 18:30'::timestamp at time zone 'America/Chicago'), ('2026-12-08 20:00'::timestamp at time zone 'America/Chicago'),
  'Clubhouse', 'Open forum; ARC requests (131 Sunset Ridge fence); payment plan requests; gate repair bid; holiday lighting contest', 'scheduled', null
where not exists (select 1 from public.pm_meetings m where m.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and m.title='Board meeting' and m.starts_at::date='2026-12-09');

-- A few open requests across the properties so the dashboard has a queue.
insert into public.service_requests (account_id, property_id, property_contact_id, request_type, category, priority, status, title, description, unit, permission_to_enter, reported_channel, short_ref, created_at)
select '06bd0c7c-2bd6-443b-a97e-19ea32c35a79', pc.property_id, pc.id, v.rt, v.cat, v.pri, v.st, v.title, v.descr, pc.unit, v.pte, 'phone', v.ref, now() - (v.age||' hours')::interval
from (values
 ('Angela Pruitt','maintenance','hvac','routine','new','Heat not keeping up','Thermostat set to 70 but the unit only reaches 64 overnight. Filter was changed last month.',true,'SR-DM0001',20),
 ('Derrick Hayes','maintenance','plumbing','routine','acknowledged','Bathroom sink drains slowly','Sink takes several minutes to drain; tried a store-bought cleaner.',true,'SR-DM0002',44),
 ('Priya Natarajan','maintenance','appliance','routine','in_progress','Dishwasher not draining','Water left standing after a cycle. Pierce Appliance scheduled Thursday after 1 PM per resident.',false,'SR-DM0003',70),
 ('Dr. Lena Okoro','maintenance','electrical','routine','new','Flickering lights in the operatory','Overhead lights in exam room 2 flicker every few minutes; started Monday.',true,'SR-DM0004',6),
 ('Elena Vasquez','maintenance','plumbing','routine','new','Restroom faucet running','Customer restroom faucet will not shut off fully.',true,'SR-DM0005',3),
 ('Diane Kowalski','violation',null,'routine','new','Violation report: RV parked at 219 Ridgeview Ct','White RV in the driveway since Saturday, blocking part of the sidewalk.',null,'SR-DM0006',30),
 ('Marcus & Tasha Bell','account','payment_plan','routine','new','Payment plan request — 207 Ridgeview Ct','Owner asks to pay the two past-due installments over four months starting December.',null,'SR-DM0007',52)
) as v(who, rt, cat, pri, st, title, descr, pte, ref, age)
join public.property_contacts pc on pc.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and pc.name=v.who
where not exists (select 1 from public.service_requests s where s.account_id='06bd0c7c-2bd6-443b-a97e-19ea32c35a79' and s.short_ref=v.ref);
