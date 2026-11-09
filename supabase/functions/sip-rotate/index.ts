import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — sip-rotate (cron-secret gated). Rotates the SIP credential Retell uses on the shared Twilio trunk, with no
// downtime: add the NEW credential (from edge secrets TWILIO_SIP_USERNAME / TWILIO_SIP_PASSWORD) to the trunk's
// credential list → point every imported Retell number at it → verify → only then remove the old username.
//   status                      -> credentials on the Twilio list (usernames only) + each Retell number's SIP config
//   add_credential              -> create the secret's username/password on the Twilio credential list
//   switch_retell {numbers?}    -> PATCH each live number in Retell to the new username/password (+ termination URI)
//   reimport {numbers[]}        -> delete + re-import each number in Retell with the new credential (seconds of gap each)
//   test_outbound {from,to}     -> place a real call from a number (uses the credential); call_status {call_id} to check
//   twilio_calls {from?,to?,minutes?} -> Twilio's call log for the trunk (proof the credential authenticated)
//   rotate_auto                 -> generate+store a new credential (app_secrets), reimport all numbers, drop the old one; nothing echoed
//   remove_credential {username}-> delete that username from the Twilio list (refuses the current secret username)
// Secrets are never echoed back.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") || "";
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
// v6: the live SIP credential lives in app_secrets (service-role only; same place as the OAuth/Stripe secrets) so a
// rotation can generate + store a password without a human ever seeing it. Edge secrets remain a fallback.
let SIP_USERNAME = Deno.env.get("TWILIO_SIP_USERNAME") || "";
let SIP_PASSWORD = Deno.env.get("TWILIO_SIP_PASSWORD") || "";
async function loadSip() {
  const { data } = await supabase.from("app_secrets").select("key,value").in("key", ["twilio_sip_username", "twilio_sip_password"]);
  const m: Record<string, string> = Object.fromEntries((data || []).map((r: any) => [r.key, String(r.value || "")]));
  if (m.twilio_sip_username && m.twilio_sip_password) { SIP_USERNAME = m.twilio_sip_username; SIP_PASSWORD = m.twilio_sip_password; }
}
function randomPassword(len = 32): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"; const bytes = new Uint8Array(len); crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
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

async function reimportNumbers(nums: string[]) {
  const results: any[] = [];
  for (const n of nums) {
    const g = await fetch(`https://api.retellai.com/get-phone-number/${encodeURIComponent(n)}`, { headers: rh() });
    const cur: any = await g.json().catch(() => ({}));
    if (!g.ok) { results.push({ number: n, ok: false, step: "get", error: cur }); continue; }
    const inboundAgents = Array.isArray(cur.inbound_agents) && cur.inbound_agents.length ? cur.inbound_agents : [{ agent_id: Deno.env.get("RETELL_AGENT_ID") || "agent_7e8792e07df78b6e366decb52a", weight: 1 }];
    const payload: any = { phone_number: n, termination_uri: TERMINATION_URI, sip_trunk_auth_username: SIP_USERNAME, sip_trunk_auth_password: SIP_PASSWORD, inbound_agents: inboundAgents, inbound_webhook_url: cur.inbound_webhook_url || `${Deno.env.get("SUPABASE_URL")}/functions/v1/retell-inbound`, nickname: cur.nickname || "Donna" };
    if (Array.isArray(cur.outbound_agents) && cur.outbound_agents.length) payload.outbound_agents = cur.outbound_agents;
    const d = await fetch(`https://api.retellai.com/delete-phone-number/${encodeURIComponent(n)}`, { method: "DELETE", headers: rh() });
    if (!d.ok && d.status !== 404) { results.push({ number: n, ok: false, step: "delete", status: d.status, error: await d.text() }); continue; }
    let imp: Response | null = null; let impBody: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      imp = await fetch("https://api.retellai.com/import-phone-number", { method: "POST", headers: rh(), body: JSON.stringify(payload) });
      impBody = await imp.json().catch(() => ({}));
      if (imp.ok) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!imp || !imp.ok) { results.push({ number: n, ok: false, step: "import", status: imp?.status, error: impBody, payload_sans_secret: { ...payload, sip_trunk_auth_password: "•••" } }); continue; }
    const after = await retellNumber(n);
    results.push({ number: n, ok: after.ok && after.sip_outbound_trunk_config?.auth_username === SIP_USERNAME, username_now: after.sip_outbound_trunk_config?.auth_username ?? null, inbound_agents: inboundAgents.length, webhook: payload.inbound_webhook_url });
  }
  return results;
}
async function addCredential(username: string, password: string) {
  const r = await fetch(`${credUrl}.json`, { method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ Username: username, Password: password }).toString() });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, sid: j?.sid, error: r.ok ? undefined : (j?.message || j) };
}
async function removeCredential(username: string) {
  const creds = await listCreds(); const c = creds.find((x) => x.username === username);
  if (!c) return { ok: true, already_gone: true };
  const r = await fetch(`${credUrl}/${c.sid}.json`, { method: "DELETE", headers: { Authorization: twAuth() } });
  return { ok: r.ok || r.status === 204, status: r.status, removed: username };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);
  const { data: secretRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  const cronSecret = (secretRow as any)?.value || "";
  if (!cronSecret || (req.headers.get("x-cron-secret") || "") !== cronSecret) return json({ ok: false, reason: "forbidden" }, 403);
  if (!TWILIO_SID || !TWILIO_TOKEN || !RETELL_API_KEY) return json({ ok: false, error: "twilio/retell not configured" });
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "status");
  await loadSip();

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
  // Retell won't rewrite trunk auth on an imported number (PATCH is accepted but ignored), so: read its config,
  // delete it, re-import with the new credential, and restore agents / webhook / nickname. A few seconds per number.
  if (action === "reimport") {
    if (!SIP_USERNAME || !SIP_PASSWORD) return json({ ok: false, error: "secrets not set" });
    const creds = await listCreds();
    if (!creds.some((c) => c.username === SIP_USERNAME)) return json({ ok: false, error: `Twilio credential list has no "${SIP_USERNAME}" yet; run add_credential first.` });
    const nums: string[] = Array.isArray(body.numbers) && body.numbers.length ? body.numbers : [];
    if (!nums.length) return json({ ok: false, error: "numbers[] required (explicit, on purpose)" });
    const results = await reimportNumbers(nums);
    return json({ ok: results.every((x) => x.ok), results });
  }
  // Full hands-off rotation. Generates a fresh username+password server-side, stores it in app_secrets, adds it to the
  // Twilio credential list, re-imports every Retell number currently on the OLD username, verifies, then removes the old
  // credential from Twilio. The password is never returned, logged, or echoed anywhere.
  if (action === "rotate_auto") {
    const oldUser = SIP_USERNAME;
    if (!oldUser) return json({ ok: false, error: "no current SIP username known (app_secrets or edge secrets)" });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    let newUser = `retelldonna-${stamp}`; if (newUser === oldUser) newUser += "b";
    const newPass = randomPassword(32);
    const added = await addCredential(newUser, newPass);
    if (!added.ok) return json({ ok: false, step: "twilio_add", error: added.error });
    // Store first, so the function (and admin-api) read the new credential from here on even if a later step fails.
    const up1 = await supabase.from("app_secrets").upsert({ key: "twilio_sip_username", value: newUser }, { onConflict: "key" });
    const up2 = await supabase.from("app_secrets").upsert({ key: "twilio_sip_password", value: newPass }, { onConflict: "key" });
    if (up1.error || up2.error) return json({ ok: false, step: "store", error: up1.error?.message || up2.error?.message, note: `Twilio now has "${newUser}" but app_secrets could not be written; remove it manually or retry.` });
    SIP_USERNAME = newUser; SIP_PASSWORD = newPass;
    const nums = await liveNumbers(); const targets: string[] = [];
    for (const n of nums) { const cur = await retellNumber(n); if (cur.ok && cur.sip_outbound_trunk_config?.auth_username === oldUser) targets.push(n); }
    const results = await reimportNumbers(targets);
    const allOk = results.every((x) => x.ok);
    const removed = allOk ? await removeCredential(oldUser) : { ok: false, skipped: true, reason: "a re-import failed; old credential left in place" };
    return json({ ok: allOk && removed.ok, old_username: oldUser, new_username: newUser, password_stored_in: "app_secrets.twilio_sip_password", reimported: results, old_credential: removed });
  }
  // Outbound test: a real call FROM the number (this is the path that uses the SIP credential) TO a target that answers.
  if (action === "test_outbound") {
    const from = String(body.from || ""); const to = String(body.to || "");
    if (!from || !to) return json({ ok: false, error: "from and to required" });
    const agent = String(body.agent_id || Deno.env.get("RETELL_AGENT_ID") || "agent_7e8792e07df78b6e366decb52a");
    const r = await fetch("https://api.retellai.com/v2/create-phone-call", { method: "POST", headers: rh(), body: JSON.stringify({ from_number: from, to_number: to, override_agent_id: agent, metadata: { purpose: "sip_rotation_test" } }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, status: r.status, error: j });
    return json({ ok: true, call_id: j.call_id, call_status: j.call_status });
  }
  if (action === "call_status") {
    const id = String(body.call_id || ""); if (!id) return json({ ok: false, error: "call_id required" });
    const r = await fetch(`https://api.retellai.com/v2/get-call/${encodeURIComponent(id)}`, { headers: rh() });
    const j: any = await r.json().catch(() => ({}));
    return json({ ok: r.ok, call_status: j.call_status, disconnection_reason: j.disconnection_reason ?? null, duration_ms: j.duration_ms ?? null, start: j.start_timestamp ?? null, end: j.end_timestamp ?? null, from: j.from_number, to: j.to_number });
  }
  if (action === "twilio_calls") {
    // Twilio's view of recent outbound trunk calls. A call that authenticated shows up here (busy/no-answer/completed);
    // a rejected SIP credential never produces a Twilio call record at all.
    const minutes = Math.min(1440, Math.max(1, Number(body.minutes || 30)));
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const q = new URLSearchParams({ PageSize: "50", "StartTime>": since }); if (body.from) q.set("From", String(body.from)); if (body.to) q.set("To", String(body.to));
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json?${q}`, { headers: { Authorization: twAuth() } });
    const j: any = await r.json().catch(() => ({}));
    const calls = (j?.calls || []).map((c: any) => ({ sid: c.sid, from: c.from, to: c.to, status: c.status, direction: c.direction, duration: c.duration, start: c.start_time }));
    return json({ ok: r.ok, since, calls, error: r.ok ? undefined : j });
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
