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
