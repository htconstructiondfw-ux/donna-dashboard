-- Card on file per client (salon checkout) + members can see tickets they served. Applied to hingbdtmxozbjetzwibj on 2026-11-10 as migration contacts_card_on_file.
-- contacts.card: { payment_method, customer, brand, last4, saved_at } on the tenant's own Stripe account. Written only by the payments webhook.
alter table public.contacts add column if not exists card jsonb;

-- Invoices: owners/managers see all; a member sees invoices they created, tickets they served, or invoices on a job assigned to them.
drop policy if exists invoices_select_scoped on public.invoices;
create policy invoices_select_scoped on public.invoices for select to authenticated
  using (
    account_id = public.current_account_id()
    and (
      public.is_account_admin()
      or created_by = auth.uid()
      or served_by = auth.uid()
      or exists (select 1 from public.jobs j where j.id = invoices.job_id and j.assigned_user_id = auth.uid())
    )
  );

-- Pay page: let a salon client tick "keep my card on file" only when the ticket is tied to a client record.
create or replace function public.invoice_public(p_token text) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency, 'kind', i.kind,
    'lines', i.lines, 'subtotal_cents', i.subtotal_cents, 'tax_cents', i.tax_cents, 'tip_cents', i.tip_cents, 'total_cents', i.total_cents,
    'notes', i.notes, 'customer_name', i.customer_name, 'service_address', i.service_address,
    'sent_at', i.sent_at, 'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_note', i.paid_note,
    'served_by_name', (select u.full_name from users u where u.id = i.served_by),
    'business', jsonb_build_object('name', a.name, 'phone', a.settings->'business'->>'phone', 'address', coalesce(a.settings->>'address', a.settings->>'office_address'), 'email', a.settings->'business'->>'email'),
    'can_pay_online', (i.status in ('sent','draft') and i.paid_at is null and coalesce(pa.charges_enabled,false) and coalesce((a.settings->'payments'->>'enabled')::boolean,false)),
    'tips_enabled', (i.kind = 'ticket' and coalesce((a.settings->'payments'->>'tips')::boolean, true)),
    'has_contact', (i.contact_id is not null),
    'card_fee_pct', coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0),
    'card_fee_cents', round(i.total_cents * coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) / 100.0)::int
  )
  from invoices i join accounts a on a.id = i.account_id
  left join payment_accounts pa on pa.account_id = i.account_id
  where i.pay_token = p_token;
$$;
