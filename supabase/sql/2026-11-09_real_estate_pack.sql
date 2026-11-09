-- Real estate industry pack (re_ prefix; never touches contractor/PM tables).
-- settings.real_estate = { lines: ['residential','commercial','land','rentals'], manages_rentals: bool, license_no, broker_name, broker_license,
--                          iabs_url, showing_agreement_text, application_fee_cents, lender_partner: {name, phone}, agent_phone }

create table if not exists public.re_listings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_user_id uuid references public.users(id) on delete set null,
  listing_type text not null default 'for_rent' check (listing_type in ('for_sale','for_rent','for_lease')),   -- for_lease = commercial
  property_type text not null default 'single_family' check (property_type in ('single_family','condo_townhome','multifamily','land','commercial','farm_ranch','new_construction','other')),
  status text not null default 'active' check (status in ('coming_soon','active','pending','under_contract','leased','sold','off_market')),
  address text not null, city text, state text default 'TX', zip text, neighborhood text,
  lat double precision, lng double precision,
  price_cents bigint,                 -- sale price or monthly rent
  price_period text default 'month',  -- 'month' for rentals, 'total' for sale, 'sqft_year' for commercial lease
  beds numeric, baths numeric, half_baths int default 0, sqft int, lot_sqft int, acres numeric, year_built int,
  garage int, stories int, pool boolean default false, office boolean default false,
  hoa_cents int, hoa_period text, taxes_cents int,
  pets text,                          -- rentals: 'no', 'cats', 'dogs', 'case_by_case'
  deposit_cents int, available_on date, lease_min_months int,
  mls_number text, description text, features text[] default '{}', photos jsonb default '[]'::jsonb,
  showing_instructions text,          -- vacant / lockbox / call first / tenant occupied (never codes to callers)
  occupied boolean default false,
  aliases text[] default '{}',        -- "the house on Elm", "Belle Maison 3903"
  notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists re_listings_acct on public.re_listings(account_id, status);
alter table public.re_listings enable row level security;
drop policy if exists re_listings_tenant on public.re_listings;
create policy re_listings_tenant on public.re_listings for all
  using (account_id = (select account_id from public.users where id = auth.uid()))
  with check (account_id = (select account_id from public.users where id = auth.uid()));
grant select, insert, update, delete on public.re_listings to authenticated;

-- Leads: who called about what, with qualification answers. Contact row holds identity; this holds the real-estate specifics.
create table if not exists public.re_leads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  listing_id uuid references public.re_listings(id) on delete set null,
  agent_user_id uuid references public.users(id) on delete set null,
  kind text not null check (kind in ('buyer','seller','renter','landlord','tenant','other')),
  name text, phone text, email text,
  source text default 'phone',
  timeline text, price_min_cents bigint, price_max_cents bigint, areas text[] default '{}',
  preapproved boolean, has_agent boolean, lender_referral boolean default false,
  property_address text,              -- seller / landlord: the home they want to sell or rent out
  beds_wanted numeric, move_in date, pets text, household_size int,
  notes text, status text not null default 'new' check (status in ('new','contacted','showing_set','applied','under_contract','closed','lost')),
  hot boolean default false,
  iabs_sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists re_leads_acct on public.re_leads(account_id, status, created_at desc);
alter table public.re_leads enable row level security;
drop policy if exists re_leads_tenant on public.re_leads;
create policy re_leads_tenant on public.re_leads for all
  using (account_id = (select account_id from public.users where id = auth.uid()))
  with check (account_id = (select account_id from public.users where id = auth.uid()));
grant select, insert, update, delete on public.re_leads to authenticated;

-- Signing module: one row per document sent for signature. Donna's own e-sign (ESIGN/UETA): consent, OTP verification,
-- intent-to-sign action, audit trail, flattened PDF + SHA-256, certificate page, immutable copy in storage.
create table if not exists public.re_documents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('showing_agreement','buyer_intake','seller_intake','landlord_intake','rental_application','consent','custom')),
  title text not null,
  body_md text,                        -- the agreement text (markdown-ish) rendered into the PDF
  fields jsonb not null default '{}'::jsonb,   -- facts Donna filled (names, address, dates); never terms
  form jsonb,                          -- for applications: the applicant's answers
  lead_id uuid references public.re_leads(id) on delete set null,
  listing_id uuid references public.re_listings(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  signer_name text, signer_phone text, signer_email text,
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  status text not null default 'sent' check (status in ('draft','sent','viewed','verified','signed','declined','expired','void')),
  sent_at timestamptz default now(), viewed_at timestamptz, consented_at timestamptz, verified_at timestamptz, signed_at timestamptz, declined_at timestamptz,
  expires_at timestamptz default (now() + interval '14 days'),
  otp_hash text, otp_sent_at timestamptz, otp_attempts int default 0,
  signature_png text,                  -- data URL, kept until flattened
  pdf_path text, pdf_sha256 text, certificate_path text,
  audit jsonb not null default '[]'::jsonb,   -- [{at, event, ip, ua, detail}]
  fee_invoice_id uuid references public.invoices(id) on delete set null,   -- application fee
  created_by uuid references public.users(id) on delete set null,
  agent_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists re_documents_acct on public.re_documents(account_id, status, created_at desc);
create index if not exists re_documents_signer on public.re_documents(account_id, signer_phone) where status = 'signed';
alter table public.re_documents enable row level security;
drop policy if exists re_documents_tenant on public.re_documents;
create policy re_documents_tenant on public.re_documents for all
  using (account_id = (select account_id from public.users where id = auth.uid()))
  with check (account_id = (select account_id from public.users where id = auth.uid()));
grant select, insert, update, delete on public.re_documents to authenticated;

-- Public read for the signing page (by token): only what the signer needs, never the OTP hash.
create or replace function public.re_document_public(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'title', d.title, 'body_md', d.body_md, 'fields', d.fields, 'form', d.form,
    'status', d.status, 'signer_name', d.signer_name, 'signer_phone_masked', case when d.signer_phone is null then null else '•••' || right(d.signer_phone, 4) end,
    'signer_email_masked', case when d.signer_email is null then null else left(d.signer_email, 2) || '•••' || substring(d.signer_email from '@.*$') end,
    'expires_at', d.expires_at, 'signed_at', d.signed_at, 'pdf_ready', d.pdf_path is not null,
    'business', jsonb_build_object('name', a.name, 'phone', a.settings->'business'->>'phone', 'email', a.settings->'business'->>'email', 'license', a.settings->'real_estate'->>'license_no', 'broker', a.settings->'real_estate'->>'broker_name'),
    'fee_cents', case when d.kind = 'rental_application' then coalesce((a.settings->'real_estate'->>'application_fee_cents')::int, 0) else 0 end,
    'listing', case when l.id is null then null else jsonb_build_object('address', l.address, 'city', l.city, 'zip', l.zip, 'price_cents', l.price_cents, 'beds', l.beds, 'baths', l.baths) end
  )
  from re_documents d join accounts a on a.id = d.account_id left join re_listings l on l.id = d.listing_id
  where d.token = p_token;
$$;
grant execute on function public.re_document_public(text) to anon, authenticated;

-- Storage for signed PDFs (private; served by signed URL).
insert into storage.buckets (id, name, public) values ('re-documents', 're-documents', false) on conflict (id) do nothing;

-- Phone Q&A: find listings by loose text ("the house on Elm", "Belle Maison 3903", a zip, "3 bedroom under 2000").
create or replace function public.re_find_listings(p_account uuid, p_q text default null, p_type text default null, p_zip text default null,
  p_min_beds numeric default null, p_max_price bigint default null, p_limit int default 5)
returns setof public.re_listings language sql stable security definer set search_path = public as $$
  select * from re_listings l
  where l.account_id = p_account and l.status in ('coming_soon','active','pending')
    and (p_type is null or l.listing_type = p_type)
    and (p_zip is null or l.zip = p_zip)
    and (p_min_beds is null or coalesce(l.beds,0) >= p_min_beds)
    and (p_max_price is null or coalesce(l.price_cents, 0) <= p_max_price)
    and (p_q is null or p_q = '' or l.address ilike '%' || p_q || '%' or coalesce(l.neighborhood,'') ilike '%' || p_q || '%'
         or exists (select 1 from unnest(l.aliases) al where al ilike '%' || p_q || '%')
         or exists (select 1 from regexp_split_to_table(p_q, '\s+') w where length(w) >= 3 and (l.address ilike '%' || w || '%' or coalesce(l.neighborhood,'') ilike '%' || w || '%')))
  order by (l.address ilike '%' || coalesce(p_q,'') || '%') desc, l.created_at desc
  limit p_limit;
$$;
grant execute on function public.re_find_listings(uuid, text, text, text, numeric, bigint, int) to service_role;
