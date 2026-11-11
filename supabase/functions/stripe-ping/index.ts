import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Staff health check for the Stripe key Donna uses (cron-secret gated, read-only). Never returns the key.
// GET /v1/balance proves the key works; connected-account read proves Connect access.
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const { data: row } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  if (!row || (req.headers.get("x-cron-secret") || "") !== (row as any).value) return json({ ok: false }, 403);
  if (!KEY) return json({ ok: false, error: "no key set" });
  const mode = KEY.startsWith("sk_live_") || KEY.startsWith("rk_live_") ? "live" : (KEY.startsWith("sk_test_") || KEY.startsWith("rk_test_") ? "test" : "unknown");
  const h = { Authorization: `Bearer ${KEY}` };
  const b = await fetch("https://api.stripe.com/v1/balance", { headers: h });
  const bj: any = await b.json().catch(() => ({}));
  let connected: any = null;
  try {
    const { data: pa } = await supabase.from("payment_accounts").select("stripe_account_id").not("stripe_account_id", "is", null).limit(1).maybeSingle();
    if ((pa as any)?.stripe_account_id) {
      const a = await fetch(`https://api.stripe.com/v1/accounts/${(pa as any).stripe_account_id}`, { headers: h });
      const aj: any = await a.json().catch(() => ({}));
      connected = { status: a.status, ok: a.ok, error: aj?.error?.code || aj?.error?.message || null };
    }
  } catch (e) { connected = { error: String(e) }; }
  return json({ ok: b.ok, mode, key_last4: KEY.slice(-4), balance_status: b.status, error: bj?.error?.message || null, connected });
});
