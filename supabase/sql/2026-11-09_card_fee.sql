-- Card processing fee: settings.payments.card_fee_pct (0 = off). Public pay page gets both prices.
CREATE OR REPLACE FUNCTION public.invoice_public(p_token text)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency,
    'lines', i.lines, 'subtotal_cents', i.subtotal_cents, 'tax_cents', i.tax_cents, 'total_cents', i.total_cents,
    'notes', i.notes, 'customer_name', i.customer_name, 'service_address', i.service_address,
    'sent_at', i.sent_at, 'paid_at', i.paid_at, 'paid_method', i.paid_method, 'paid_note', i.paid_note,
    'business', jsonb_build_object('name', a.name, 'phone', a.settings->'business'->>'phone', 'address', coalesce(a.settings->>'address', a.settings->>'office_address'), 'email', a.settings->'business'->>'email'),
    'can_pay_online', (i.status in ('sent','draft') and i.paid_at is null and coalesce(pa.charges_enabled,false) and coalesce((a.settings->'payments'->>'enabled')::boolean,false)),
    'card_fee_pct', coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0),
    'card_fee_cents', round(i.total_cents * coalesce((a.settings->'payments'->>'card_fee_pct')::numeric, 0) / 100.0)::int
  )
  from invoices i join accounts a on a.id = i.account_id
  left join payment_accounts pa on pa.account_id = i.account_id
  where i.pay_token = p_token;
$function$;
