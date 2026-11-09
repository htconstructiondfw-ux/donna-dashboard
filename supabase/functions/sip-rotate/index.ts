import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — sip-rotate (cron-secret gated). Rotates the SIP credential Retell uses on the shared Twilio trunk, with no
// downtime: add the NEW credential (from edge secrets TWILIO_SIP_USERNAME / TWILIO_SIP_PASSWORD) to the trunk's
// credential list → point every imported Retell number at it → verify → only then remove the old username.
//   status                      -> credentials on the Twilio list (usernames only) + each Retell number's SIP config
//   add_credential              -> create the secret's username/password on the Twilio credential list
//   switch_retell {numbers?}    -> PATCH each live number in Retell to the new username/password (+ termination URI)
//   remove_credential {username}-> delete that username from the Twilio list (refuses the current secret username)
// Secrets are never echoed back.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") || "";
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const SIP_USERNAME = Deno.env.get("TWILIO_SIP_USERNAME") || "";
const SIP_PASSWORD = Deno.env.get("TWILIO_SIP_PASSWORD") || "";
const CRED_LIST_SID = "CL03a135cfb5f1f04e3ee60ee644c12261";
const TERMINATION_URI = "sidekick-donna.pstn.twilio.com";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const twAuth = () => "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`);
const rh = () => ({ Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" });
const credUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/SIP/CredentialLists/${CRED_LIST_SID}/Credentials`;

async function listCreds(): Promise<{ sid: string; username: string }[]> {
  const r = await fetch(`${credUrl}.json?PageSize=50`, { headers: { Authorization: twAuth() } });
  const j: any = await r.json().catch(() => ({}));
  return (j?.credentials || []).map((c: any) => ({ sid: c.sid, username: c.username }));
}
async function liveNumbers(): Promise<string[]> {
  const { data } = await supabase.from("assistants").select("twilio_number").not("twilio_number", "is", null);
  return (data || []).map((a: any) => String(a.twilio_number)).filter((n) => /^\+1[2-9]\d{9}$/.test(n) && !n.startsWith("+1555"));
}
async function retellNumber(n: string): Promise<any> {
  const r = await fetch(`https://api.retellai.com/get-phone-number/${encodeURIComponent(n)}`, { headers: rh() });
  const j: any = await r.json().catch(() => ({}));
  const cfg: any = j?.sip_outbound_trunk_config || null;
  const masked = cfg && typeof cfg === "object" ? Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, /pass/i.test(k) ? (v ? "•••" : v) : v])) : cfg;
  return { ok: r.ok, status: r.status, number: n, nickname: j?.nickname ?? null, type: j?.phone_number_type ?? null, sip_outbound_trunk_config: masked, legacy_username: j?.sip_trunk_auth_username ?? null, error: r.ok ? undefined : j };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);
  const { data: secretRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  const cronSecret = (secretRow as any)?.value || "";
  if (!cronSecret || (req.headers.get("x-cron-secret") || "") !== cronSecret) return json({ ok: false, reason: "forbidden" }, 403);
  if (!TWILIO_SID || !TWILIO_TOKEN || !RETELL_API_KEY) return json({ ok: false, error: "twilio/retell not configured" });
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "status");

  if (action === "status") {
    const creds = await listCreds();
    const nums = await liveNumbers();
    const retell = []; for (const n of nums) retell.push(await retellNumber(n));
    return json({ ok: true, secret_username: SIP_USERNAME || null, secret_password_set: !!SIP_PASSWORD, twilio_credentials: creds, retell });
  }
  if (action === "add_credential") {
    if (!SIP_USERNAME || !SIP_PASSWORD) return json({ ok: false, error: "secrets not set" });
    const existing = await listCreds();
    if (existing.some((c) => c.username === SIP_USERNAME)) return json({ ok: true, already: true, username: SIP_USERNAME });
    const r = await fetch(`${credUrl}.json`, { method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Username: SIP_USERNAME, Password: SIP_PASSWORD }).toString() });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, status: r.status, error: j?.message || j });
    return json({ ok: true, added: SIP_USERNAME, sid: j.sid });
  }
  if (action === "switch_retell") {
    if (!SIP_USERNAME || !SIP_PASSWORD) return json({ ok: false, error: "secrets not set" });
    const creds = await listCreds();
    if (!creds.some((c) => c.username === SIP_USERNAME)) return json({ ok: false, error: `Twilio credential list has no "${SIP_USERNAME}" yet; run add_credential first.` });
    const nums: string[] = Array.isArray(body.numbers) && body.numbers.length ? body.numbers : await liveNumbers();
    const results = [];
    for (const n of nums) {
      // Retell's current shape keeps SIP auth under sip_outbound_trunk_config; keep the other keys of the existing config.
      const cur = await retellNumber(n); const curCfg: any = (cur.ok && cur.sip_outbound_trunk_config && typeof cur.sip_outbound_trunk_config === "object") ? cur.sip_outbound_trunk_config : {};
      const payload: any = { sip_outbound_trunk_config: { ...curCfg, termination_uri: TERMINATION_URI, auth_username: SIP_USERNAME, auth_password: SIP_PASSWORD } };
      const r = await fetch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(n)}`, { method: "PATCH", headers: rh(), body: JSON.stringify(payload) });
      const j: any = await r.json().catch(() => ({}));
      const after: any = j?.sip_outbound_trunk_config || {};
      results.push({ number: n, ok: r.ok, status: r.status, username_now: after.auth_username ?? null, termination_uri: after.termination_uri ?? null, error: r.ok ? undefined : (j?.message || j?.error_message || j) });
    }
    return json({ ok: results.every((x) => x.ok), results });
  }
  if (action === "remove_credential") {
    const username = String(body.username || "");
    if (!username) return json({ ok: false, error: "username required" });
    if (username === SIP_USERNAME) return json({ ok: false, error: "refusing to remove the username the secrets currently point to" });
    const creds = await listCreds(); const c = creds.find((x) => x.username === username);
    if (!c) return json({ ok: true, already_gone: true });
    const r = await fetch(`${credUrl}/${c.sid}.json`, { method: "DELETE", headers: { Authorization: twAuth() } });
    return json({ ok: r.ok || r.status === 204, status: r.status, removed: username });
  }
  return json({ ok: false, error: "unknown action" });
});
