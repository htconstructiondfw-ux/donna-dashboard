// msg-inbound (v12)
// Twilio SMS intake. Two paths:
//  1) SHARED toll-free number (reminders/confirmations): match the sender to a
//     recent appointment, handle STOP, then let msg-quick handle confirm / reschedule /
//     cancel / running-late / "when is my appointment" deterministically; anything else is
//     forwarded to the tenant's inbox. Replies inline via TwiML.
//  2) TENANT-OWNED number (two-way): look up the tenant by assistants.sms_number, log the
//     message, try msg-quick first, then route to the msg-brain conversation engine.
// v10: texts from a CREW phone (a users.phone on a contractor account, or any account with
//     features.crew_text) go to crew-text first on both paths: OMW / DONE / LATE / TODAY / photos.
// v12: tenant-number path converses (msg-brain) ONLY when settings.sms.two_way && two_way_verified; otherwise it
//     acknowledges inline and forwards to the owner. Notifications always leave via the toll-free (see msg-send).
// verify_jwt = false because Twilio authenticates by signature.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

const OPT_OUT = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT"]);
const OPT_IN = new Set(["START", "UNSTOP"]);

function xml(msg = ""): Response {
  const inner = msg ? `<Message>${escapeXml(msg)}</Message>` : "";
  const bodyStr = `<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>${inner}</Response>`;
  return new Response(bodyStr, { status: 200, headers: { "Content-Type": "text/xml" } });
}
function escapeXml(s: string): string {
  return s.replace(/[<>&'\"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '\"': "&quot;" }[c]!));
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyTwilio(url: string, params: Record<string, string>, signature: string): Promise<boolean> {
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqual(b64, signature);
}
const normPhone = (p: string) => (p ?? "").replace(/[^\d+]/g, "");
const digits = (p: string) => String(p ?? "").replace(/\D/g, "");
const last10 = (p: string) => digits(p).slice(-10);
function fmtWhen(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}
async function sendEmail(from: string, to: string, subject: string, text: string) {
  if (!RESEND_KEY || !from || !to) return;
  try {
    await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) });
  } catch (e) { console.error("notify email threw", String(e)); }
}
async function invoke(fn: string, payload: unknown): Promise<any> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(payload) });
    return await r.json().catch(() => null);
  } catch (e) { console.error(`invoke ${fn} failed:`, e); return null; }
}

// Crew detection: is this phone a user on an account that runs by text? (contractors, or features.crew_text)
async function findCrew(sb: any, from: string, accountId?: string): Promise<{ user_id: string; account_id: string } | null> {
  const l10 = last10(from); if (l10.length !== 10) return null;
  let q = sb.from("users").select("id, account_id, phone, updated_at, accounts!inner(industry, settings)").not("phone", "is", null).order("updated_at", { ascending: false }).limit(200);
  if (accountId) q = q.eq("account_id", accountId);
  const { data } = await q;
  const hits = (data || []).filter((u: any) => last10(u.phone) === l10 && (u.accounts?.industry === "contractor" || u.accounts?.settings?.features?.crew_text === true));
  return hits.length ? { user_id: hits[0].id, account_id: hits[0].account_id } : null;
}

async function handleShared(sb: any, from: string, bodyText: string, upper: string, media: string[]): Promise<Response> {
  const fromL10 = last10(from);
  if (fromL10.length !== 10) return xml();

  // Crew member texting the shared number: run it as a command.
  const crew = await findCrew(sb, from);
  if (crew && (bodyText || media.length)) {
    const c = await invoke("crew-text", { account_id: crew.account_id, user_id: crew.user_id, from, body: bodyText, media });
    if (c?.handled) return xml(String(c.reply || ""));
  }

  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: appts } = await sb.from("appointments")
    .select("id, account_id, starts_at, confirmed_at, contact_id, contacts(phone, name)")
    .in("status", ["scheduled", "confirmed"]).gt("starts_at", sinceIso).order("starts_at", { ascending: true }).limit(500);
  const match = (appts || []).find((a: any) => last10(a?.contacts?.phone || "") === fromL10);
  if (!match) { if (crew) return xml(`Didn't catch that. Text HELP for what I can do.`); return xml(); }

  const accountId = match.account_id as string;
  const { data: acct } = await sb.from("accounts").select("name, settings").eq("id", accountId).maybeSingle();
  const settings: any = acct?.settings || {};
  const business = acct?.name || "us";
  const tz = String(settings.timezone || "America/Chicago");
  const generalBox = String(settings.alert_email || settings.escalation_email || "").trim();
  const fromAddr = String(settings.email_reply_from || `${business} <no-reply@client.sidekicklogistics.com>`).trim();
  const when = fmtWhen(match.starts_at as string, tz);
  const clientName = String(match?.contacts?.name || from).trim();

  if (OPT_OUT.has(upper)) { await sb.from("suppressions").upsert({ account_id: accountId, customer_identifier: from, reason: "opt_out" }, { onConflict: "account_id,customer_identifier" }); return xml(); }
  if (OPT_IN.has(upper)) { await sb.from("suppressions").delete().eq("account_id", accountId).eq("customer_identifier", from); return xml(); }

  // Deterministic appointment replies (confirm / move / cancel / late / when). Reply inline from the shared number.
  const q = await invoke("msg-quick", { account_id: accountId, from, body: bodyText, send: false });
  if (q?.handled && q.reply) return xml(String(q.reply));

  if (generalBox) await sendEmail(fromAddr, generalBox, "Text reply from a client", `${clientName} replied by text about their ${when} appointment:\n\n\"${bodyText}\"\n\nReach them at ${from}.`);
  return xml(`Thanks! ${business} will follow up if needed. Reply R to move your appointment, CANCEL to cancel it, or STOP to opt out.`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const raw = await req.text();
  const form = new URLSearchParams(raw);
  const params: Record<string, string> = {};
  for (const [k, v] of form) params[k] = v;

  if (!TWILIO_AUTH_TOKEN) { console.error("msg-inbound: TWILIO_AUTH_TOKEN not set"); return new Response("transport not configured", { status: 503 }); }
  const signature = req.headers.get("X-Twilio-Signature") ?? "";
  const verified = await verifyTwilio(req.url, params, signature);
  if (!verified) { console.warn("msg-inbound: signature verification failed", req.url); return new Response("forbidden", { status: 403 }); }

  const from = (params["From"] ?? "").trim();
  const to = (params["To"] ?? "").trim();
  const bodyText = (params["Body"] ?? "").trim();
  const messageSid = params["MessageSid"] ?? params["SmsSid"] ?? null;
  const upper = bodyText.toUpperCase();
  const media: string[] = []; for (let i = 0; i < Number(params["NumMedia"] || 0) && i < 10; i++) if (params[`MediaUrl${i}`]) media.push(params[`MediaUrl${i}`]);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ---- Path 1: the shared reminders number ----
  const { data: cfg } = await sb.from("app_config").select("value").eq("key", "twilio_sms_number").maybeSingle();
  const sharedNumber = (cfg as any)?.value || "";
  if (sharedNumber && last10(to) === last10(sharedNumber)) {
    return await handleShared(sb, from, bodyText, upper, media);
  }

  // ---- Path 2: a tenant-owned two-way number ----
  const { data: assistant, error: aErr } = await sb.from("assistants").select("id, account_id, routing").eq("sms_number", to).maybeSingle();
  if (aErr) { console.error("msg-inbound: assistant lookup error", aErr); return xml(); }
  if (!assistant) { console.warn("msg-inbound: no assistant for sms_number", to); return xml(); }

  const accountId = assistant.account_id as string;
  const routing = (assistant.routing ?? {}) as Record<string, unknown>;
  const directory = Array.isArray(routing.directory) ? (routing.directory as Array<Record<string, unknown>>) : [];
  const inDirectory = directory.some((d) => normPhone(String(d.phone ?? "")) === normPhone(from));

  // Crew member of this tenant: commands first.
  const crew = await findCrew(sb, from, accountId);
  if (crew && (bodyText || media.length)) {
    const c = await invoke("crew-text", { account_id: accountId, user_id: crew.user_id, from, body: bodyText, media });
    if (c?.handled) return xml(String(c.reply || ""));
  }
  const isStaff = inDirectory || !!crew;

  if (!isStaff && OPT_OUT.has(upper)) {
    await sb.from("suppressions").upsert({ account_id: accountId, customer_identifier: from, reason: "opt_out" }, { onConflict: "account_id,customer_identifier" });
    return xml();
  }
  if (!isStaff && OPT_IN.has(upper)) {
    await sb.from("suppressions").delete().eq("account_id", accountId).eq("customer_identifier", from);
    return xml();
  }
  if (isStaff) {
    await invoke("msg-approval", { account_id: accountId, staff_number: from, body: bodyText, provider_message_id: messageSid });
    return crew ? xml(`Didn't catch that. Text HELP for what I can do.`) : xml();
  }

  const { data: supp } = await sb.from("suppressions").select("id").eq("account_id", accountId).eq("customer_identifier", from).maybeSingle();
  if (supp) return xml();

  // v12: two-way texting on this number only when the account has it enabled AND the number is verified.
  // Otherwise: acknowledge inline (TwiML, no outbound send), log it, and hand the text to the owner's inbox.
  const { data: acctRow } = await sb.from("accounts").select("name, settings").eq("id", accountId).maybeSingle();
  const acctSettings: any = (acctRow as any)?.settings || {};
  const twoWayReady = acctSettings?.sms?.two_way === true && acctSettings?.sms?.two_way_verified === true;

  let contactId: string | null = null;
  const { data: existing } = await sb.from("contacts").select("id").eq("account_id", accountId).eq("phone", from).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (existing) { contactId = existing.id; }
  else {
    const { data: created } = await sb.from("contacts").insert({ account_id: accountId, phone: from, source: "sms" }).select("id").maybeSingle();
    contactId = created?.id ?? null;
  }

  const nowIso = new Date().toISOString();
  const { data: convo } = await sb.from("conversations").upsert(
    { account_id: accountId, contact_id: contactId, channel: "sms", customer_identifier: from, last_inbound_at: nowIso },
    { onConflict: "account_id,channel,customer_identifier" },
  ).select("id").maybeSingle();
  if (!convo) { console.error("msg-inbound: conversation upsert failed"); return xml(); }
  const conversationId = convo.id as string;

  const { data: msg } = await sb.from("conversation_messages").insert({
    account_id: accountId, conversation_id: conversationId, direction: "inbound", actor: "customer", channel: "sms", body: bodyText, provider_message_id: messageSid, status: "received",
  }).select("id").maybeSingle();

  if (!twoWayReady) {
    // Appointment keywords still work inline (reply travels back on the number they texted, no outbound send needed).
    const q0 = await invoke("msg-quick", { account_id: accountId, from, body: bodyText, conversation_id: conversationId, send: false });
    if (q0?.handled && q0.reply) { await sb.from("conversation_messages").insert({ account_id: accountId, conversation_id: conversationId, direction: "outbound", actor: "donna", channel: "sms", body: String(q0.reply), status: "sent" }); return xml(String(q0.reply)); }
    const business = String((acctRow as any)?.name || "us");
    const generalBox = String(acctSettings.alert_email || acctSettings.escalation_email || "").trim();
    const fromAddr = String(acctSettings.email_reply_from || `${business} <no-reply@client.sidekicklogistics.com>`).trim();
    if (generalBox) await sendEmail(fromAddr, generalBox, `Text from ${from}`, `${from} texted ${business}:\n\n"${bodyText}"\n\nTwo-way texting isn't active on this number yet, so Donna only acknowledged it. Reply to them directly at ${from}.`);
    await sb.from("conversations").update({ status: "awaiting_staff", updated_at: nowIso }).eq("id", conversationId);
    const ack = `Thanks for texting ${business}! We got your message and someone will get back to you shortly. For anything urgent, please call us.`;
    await sb.from("conversation_messages").insert({ account_id: accountId, conversation_id: conversationId, direction: "outbound", actor: "donna", channel: "sms", body: ack, status: "sent" });
    return xml(ack);
  }

  // Deterministic appointment replies first (confirm / move / cancel / late / when); the LLM handles everything else.
  const q = await invoke("msg-quick", { account_id: accountId, from, body: bodyText, conversation_id: conversationId, send: true, two_way: true });
  if (q?.handled) return xml();

  await invoke("msg-brain", { account_id: accountId, conversation_id: conversationId, message_id: msg?.id ?? null, from, body: bodyText });
  return xml();
});
