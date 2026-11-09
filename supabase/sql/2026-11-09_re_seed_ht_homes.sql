-- Pilot seed: HT Homes (0db6e285-a7fe-4eb3-bb12-e6952a76e0f0), 13 Belle Maison rentals. Run AFTER 2026-11-09_real_estate_pack.sql.
insert into public.re_listings (account_id, agent_user_id, listing_type, property_type, status, address, city, state, zip, neighborhood, price_cents, price_period, beds, baths, half_baths, sqft, office, pets, deposit_cents, available_on, lease_min_months, description, features, aliases, showing_instructions, occupied)
select '0db6e285-a7fe-4eb3-bb12-e6952a76e0f0', '3e61d792-35b2-42f2-b01b-26ac1b8a2376', 'for_rent', 'single_family', 'active',
       n || ' Belle Maison Dr', 'Arlington', 'TX', '76016', 'Belle Maison', 370000, 'month', 4, 3, 0, 3000, true, 'case_by_case', 370000, current_date, 12,
       'Four bedrooms plus a separate office (many use it as a fifth bedroom), three full baths, about 3,000 square feet, in the Belle Maison community in Arlington.',
       array['office','4 bedrooms + office','3 full baths','3,000 sq ft'], array['Belle Maison ' || n, n::text], 'Vacant. Agent meets at the property.', false
from unnest(array[3903,3905,3907,3909,3910,3911,3912,3914,3915,3916,3917,3918,3919]) as n
where not exists (select 1 from public.re_listings where account_id='0db6e285-a7fe-4eb3-bb12-e6952a76e0f0' and address = n || ' Belle Maison Dr');
select count(*) as listings from public.re_listings where account_id='0db6e285-a7fe-4eb3-bb12-e6952a76e0f0';
