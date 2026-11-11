import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sandbox-only helper for billing tests: advance a Stripe test clock, read a test clock or invoice.
// Internal only (x-cron-secret), and refuses to run with a live Stripe key.
//   { action: "advance", clock, frozen_time } | { action: "clock", clock } | { action: "invoices", customer }

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const { data } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  if (!data || req.headers.get("x-cron-secret") !== (data as any).value) return json({ ok: false, error: "internal_only" }, 403);
  const key = Deno.env.get("STRIPE_SECRET_KEY") || "";
  if (!/^(sk|rk)_test_/.test(key)) return json({ ok: false, error: "sandbox_only" }, 403);
  const body: any = await req.json().catch(() => ({}));
  const h = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
  let r: Response;
  if (body.action === "advance") r = await fetch(`https://api.stripe.com/v1/test_helpers/test_clocks/${body.clock}/advance`, { method: "POST", headers: { ...h, "Content-Type": "application/x-www-form-urlencoded" }, body: `frozen_time=${Number(body.frozen_time)}` });
  else if (body.action === "clock") r = await fetch(`https://api.stripe.com/v1/test_helpers/test_clocks/${body.clock}`, { headers: h });
  else if (body.action === "invoices") r = await fetch(`https://api.stripe.com/v1/invoices?customer=${encodeURIComponent(body.customer)}&limit=10&expand[]=data.lines`, { headers: h });
  else return json({ ok: false, error: "unknown_action" }, 400);
  const j: any = await r.json().catch(() => ({}));
  if (body.action === "invoices") return json({ ok: r.ok, invoices: (j.data || []).map((i: any) => ({ id: i.id, status: i.status, billing_reason: i.billing_reason, total: i.total, period_start: i.period_start, period_end: i.period_end, lines: (i.lines?.data || []).map((l: any) => `${l.description} = ${l.amount}`) })) });
  return json({ ok: r.ok, status: j.status, frozen_time: j.frozen_time, error: j.error?.message });
});
