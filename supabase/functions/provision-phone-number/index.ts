import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — provision (or change) a phone number for a client, Twilio-native (tenant self-service path).
// Flow: buy a number in the owner's Twilio account -> attach it to the voice SIP
// trunk (inbound routes to Retell) -> import into Retell (custom number:
// termination_uri + inbound_agents + webhook) -> save as twilio_number + sms_number
// so the number is owned in Twilio and usable for texting under the owner's A2P.
// v15: a new number switches texting on by default (confirmations + reminders) unless the
// owner has already made a choice under Notifications.
// v20: trial accounts may provision (invite-gated signups; wizard needs a number on day one).
// v19: SIP trunk credential comes from the same place as admin-api / sip-rotate (app_secrets
// twilio_sip_username/password, falling back to the TWILIO_SIP_* edge secrets) instead of the
// never-populated app_config keys; refuses to provision without one so a number is never imported
// into Retell with no trunk auth. Also wires the number's SMS webhook to msg-inbound at purchase.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") || "";
const RETELL_AGENT_ID = Deno.env.get("RETELL_AGENT_ID") || "agent_7e8792e07df78b6e366decb52a";
const T_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const T_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
const tBasic = () => "Basic " + btoa(`${T_SID}:${T_TOKEN}`);
const form = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
async function cfg(key: string): Promise<string> { const { data } = await admin.from("app_config").select("value").eq("key", key).maybeSingle(); return (data as any)?.value || ""; }
async function sipCredential(): Promise<{ user: string; pass: string }> {
  const { data } = await admin.from("app_secrets").select("key,value").in("key", ["twilio_sip_username", "twilio_sip_password"]);
  const m: Record<string, string> = Object.fromEntries((data || []).map((r: any) => [r.key, String(r.value || "")]));
  if (m.twilio_sip_username && m.twilio_sip_password) return { user: m.twilio_sip_username, pass: m.twilio_sip_password };
  return { user: Deno.env.get("TWILIO_SIP_USERNAME") || "", pass: Deno.env.get("TWILIO_SIP_PASSWORD") || "" };
}

async function twilioBuy(areaCode: string, trunkSid: string, nickname: string) {
  const q = new URLSearchParams({ VoiceEnabled: "true", SmsEnabled: "true", PageSize: "1" });
  if (areaCode) q.set("AreaCode", areaCode);
  const av = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${T_SID}/AvailablePhoneNumbers/US/Local.json?${q}`, { headers: { Authorization: tBasic() } });
  const avj: any = await av.json().catch(() => ({}));
  const cand = (avj?.available_phone_numbers || [])[0]?.phone_number;
  if (!cand) return { ok: false as const, error: areaCode ? "No numbers are available in that area code. Try a nearby one." : "No numbers available right now." };
  const b: Record<string, string> = { PhoneNumber: cand, FriendlyName: nickname, SmsUrl: `${SUPABASE_URL}/functions/v1/msg-inbound`, SmsMethod: "POST" };
  if (trunkSid) b.TrunkSid = trunkSid;
  const buy = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${T_SID}/IncomingPhoneNumbers.json`, { method: "POST", headers: { Authorization: tBasic(), "Content-Type": "application/x-www-form-urlencoded" }, body: form(b) });
  const buyj: any = await buy.json().catch(() => ({}));
  if (!buy.ok || !buyj?.phone_number) return { ok: false as const, error: buyj?.message || `Couldn't purchase a number (Twilio ${buy.status}).` };
  return { ok: true as const, number: buyj.phone_number, sid: buyj.sid, pretty: buyj.friendly_name || buyj.phone_number };
}
async function twilioReleaseBySid(sid: string) { try { await fetch(`https://api.twilio.com/2010-04-01/Accounts/${T_SID}/IncomingPhoneNumbers/${sid}.json`, { method: "DELETE", headers: { Authorization: tBasic() } }); } catch (_e) { /* best effort */ } }
async function twilioReleaseByNumber(num: string) { try { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${T_SID}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(num)}`, { headers: { Authorization: tBasic() } }); const j: any = await r.json().catch(() => ({})); const sid = (j?.incoming_phone_numbers || [])[0]?.sid; if (sid) await twilioReleaseBySid(sid); } catch (_e) { /* best effort */ } }
async function retellDelete(num: string) { try { await fetch(`https://api.retellai.com/delete-phone-number/${encodeURIComponent(num)}`, { method: "DELETE", headers: { Authorization: `Bearer ${RETELL_API_KEY}` } }); } catch (_e) { /* best effort */ } }
async function retellImport(number: string, nickname: string, term: string, user: string, pass: string) {
  const payload: Record<string, unknown> = { phone_number: number, inbound_agents: [{ agent_id: RETELL_AGENT_ID, weight: 1 }], inbound_webhook_url: `${SUPABASE_URL}/functions/v1/retell-inbound`, nickname };
  if (term) payload.termination_uri = term;
  if (user) payload.sip_trunk_auth_username = user;
  if (pass) payload.sip_trunk_auth_password = pass;
  const r = await fetch("https://api.retellai.com/import-phone-number", { method: "POST", headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { ok: r.ok, status: r.status, detail: await r.json().catch(() => ({})) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (!RETELL_API_KEY || !T_SID || !T_TOKEN) return json({ ok: false, error: "Phone provisioning isn't configured yet." });

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ ok: false, error: "You need to be signed in to set up a number." });
  const { data: me } = await admin.from("users").select("account_id").eq("id", user.id).maybeSingle();
  if (!me?.account_id) return json({ ok: false, error: "No account found for your login." });
  const accountId = me.account_id;

  const { data: acct } = await admin.from("accounts").select("status, name, settings").eq("id", accountId).maybeSingle();
  // v20: trials get a number too — signups are invite-gated and the setup wizard needs the number on day one. Only paused/cancelled accounts are refused.
  if (!acct || !["active", "trial"].includes(String(acct.status || ""))) return json({ ok: false, code: "not_active", error: "A phone number is included once your plan is active. Reach out to finish setting up billing." });

  let body: any = {}; try { body = await req.json(); } catch { /* area code optional */ }
  const replace = body?.replace === true;
  const rawArea = String(body?.area_code ?? "").replace(/\D/g, "");
  if (rawArea && rawArea.length !== 3) return json({ ok: false, error: "Enter a 3-digit US area code." });

  const { data: asst } = await admin.from("assistants").select("id, twilio_number").eq("account_id", accountId).order("created_at").limit(1).maybeSingle();
  if (!asst) return json({ ok: false, error: "No assistant found for this account." });
  const existing = asst.twilio_number as string | null;
  if (existing && !replace) return json({ ok: true, already: true, phone_number: existing, message: "This account already has a number." });

  const trunkSid = await cfg("twilio_voice_trunk_sid");
  const term = await cfg("twilio_voice_termination_uri");
  const { user: user2, pass } = await sipCredential();
  if (!trunkSid || !term || !user2 || !pass) return json({ ok: false, error: "Phone provisioning isn't fully configured yet. Please reach out and we'll set up your number." });
  const nickname = acct.name || "Donna client";

  const bought = await twilioBuy(rawArea, trunkSid, nickname);
  if (!bought.ok) return json({ ok: false, error: bought.error });

  const imp = await retellImport(bought.number, nickname, term, user2, pass);
  if (!imp.ok) { await twilioReleaseBySid(bought.sid); return json({ ok: false, error: `Couldn't connect the number to the phone system (Retell ${imp.status}).`, detail: imp.detail }); }

  if (existing && replace) { await retellDelete(existing); await twilioReleaseByNumber(existing); }

  const { error: upErr } = await admin.from("assistants").update({ twilio_number: bought.number, sms_number: bought.number }).eq("id", asst.id);
  if (upErr) return json({ ok: false, error: `Number ${bought.number} was created but could not be saved: ${upErr.message}.`, phone_number: bought.number });

  // Texting on by default with the new number (owner can switch it off under Notifications).
  try {
    const s: any = (acct as any).settings || {};
    if (!s.sms || s.sms.enabled === undefined) {
      const { data: fresh } = await admin.from("accounts").select("settings").eq("id", accountId).maybeSingle();
      const base: any = (fresh as any)?.settings || s;
      const sms = { ...(base.sms || {}), enabled: true, confirmations: true, reminders: true };
      await admin.from("accounts").update({ settings: { ...base, sms } }).eq("id", accountId);
    }
  } catch (_e) { /* non-fatal */ }

  return json({ ok: true, phone_number: bought.number, phone_number_pretty: bought.pretty, replaced: !!(existing && replace) });
});
