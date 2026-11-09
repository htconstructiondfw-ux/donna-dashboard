import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — msg-send (v5). The ONE place every text leaves Donna. Policy (Hubert, Nov 9):
//
//   NOTIFICATIONS (default) — confirmations, reminders, pay/estimate/sign links, one-time codes, crew pages, owner alerts —
//   ALWAYS go out from the shared toll-free number via its Messaging Service. Never from a tenant's number.
//
//   TWO-WAY (`two_way: true`, or an explicit `from`) — Donna replying in a text conversation — goes out from the tenant's
//   OWN number, and ONLY when that account has two-way texting enabled AND the number is verified
//   (settings.sms.two_way === true && settings.sms.two_way_verified === true, set by a platform admin). Otherwise the send
//   is refused with reason "two_way_not_ready" — it is never silently rerouted through the toll-free.
//
// Honors the suppressions (opt-out) list. Service-role callers only.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TOK = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const twAuth = () => "Basic " + btoa(`${SID}:${TOK}`);
const normPhone = (p: string) => String(p ?? "").replace(/[^\d+]/g, "");
async function cfg(key: string): Promise<string> { const { data } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle(); return String((data as any)?.value || "").trim(); }
async function twilioSend(to: string, text: string, sender: { from?: string; msid?: string }) {
  const form = new URLSearchParams(); form.set("To", to); form.set("Body", text);
  if (sender.from) form.set("From", sender.from); else if (sender.msid) form.set("MessagingServiceSid", sender.msid);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, { method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.status < 300, status: r.status, j };
}

Deno.serve(async (req: Request) => {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!tok || tok !== SERVICE_ROLE) return json({ ok: false, reason: "unauthorized" }, 401);
  let body: any = {}; try { body = await req.json(); } catch {}
  const accountId = String(body.account_id || "");
  const to = normPhone(String(body.to || ""));
  const text = String(body.body || "").trim();
  const explicitFrom = normPhone(String(body.from || ""));
  const twoWay = body.two_way === true || !!explicitFrom;
  if (!to || !text) return json({ ok: false, reason: "missing_to_or_body" });
  if (!SID || !TOK) return json({ ok: false, reason: "twilio_not_configured" });

  if (accountId) {
    const { data: supp } = await supabase.from("suppressions").select("id").eq("account_id", accountId).eq("customer_identifier", to).maybeSingle();
    if (supp) return json({ ok: false, reason: "suppressed" });
  }

  // ---- Two-way: tenant's own number, only when enabled + verified ----
  if (twoWay) {
    if (!accountId) return json({ ok: false, reason: "two_way_needs_account" });
    const [{ data: acct }, { data: asst }] = await Promise.all([
      supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle(),
      supabase.from("assistants").select("sms_number").eq("account_id", accountId).not("sms_number", "is", null).order("created_at").limit(1).maybeSingle(),
    ]);
    const sms: any = (acct as any)?.settings?.sms || {};
    const tenantNumber = normPhone(String((asst as any)?.sms_number || ""));
    const ready = sms.two_way === true && sms.two_way_verified === true && !!tenantNumber;
    if (!ready) return json({ ok: false, reason: "two_way_not_ready", enabled: sms.two_way === true, verified: sms.two_way_verified === true, has_number: !!tenantNumber });
    if (explicitFrom && explicitFrom !== tenantNumber) return json({ ok: false, reason: "from_mismatch", expected: tenantNumber });
    const r = await twilioSend(to, text, { from: tenantNumber });
    if (!r.ok) return json({ ok: false, reason: "send_failed", via: "two_way", status: r.status, detail: r.j });
    return json({ ok: true, sid: r.j.sid, status: r.j.status, via: "two_way", from: tenantNumber });
  }

  // ---- Notifications: the shared toll-free, always ----
  const msid = await cfg("twilio_messaging_service_sid");
  if (!msid) return json({ ok: false, reason: "no_messaging_service" });
  const tollfreeVerified = (await cfg("tollfree_verified")) === "true";
  const r = await twilioSend(to, text, { msid });
  if (!r.ok) return json({ ok: false, reason: "send_failed", via: "notifications", status: r.status, detail: r.j, tollfree_verified: tollfreeVerified });
  // Twilio queues even when the toll-free is unverified and then drops it; surface that so callers/logs can tell.
  return json({ ok: true, sid: r.j.sid, status: r.j.status, via: "notifications", tollfree_verified: tollfreeVerified, ...(tollfreeVerified ? {} : { warning: "tollfree_unverified: carriers will likely drop this message until verification completes" }) });
});
