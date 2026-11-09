import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — take a message (Retell custom function) v23
// Saves caller name, callback number, message, language, urgency, and who the
// message is for. When the message is for a named person, it resolves that person
// FIRST against the staff list (so a stylist gets their own message), then the Pro
// transfer directory. A matched staff member is emailed directly; the general box is
// copied unless notify.copy_stylist_messages is off. The message is tagged to them
// (notify_user_id) so it also shows in their dashboard inbox. General and emergency
// messages go to the general box.
// v21: contractor after-hours. When the account takes after-hours jobs and the message is
// urgent, Donna opens an emergency job, and either (a) texts the caller a pay link for the
// after-hours fee first (prepay on; the on-call tech is paged when it's paid, by `payments`),
// or (b) pages the on-call tech by text right away.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";

const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
async function retellSigValid(rawBody: string, sigHeader: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sigHeader) return false;
  const m = String(sigHeader).match(/v=(\d+),d=(.*)/);
  if (!m) return false;
  const ts = m[1];
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody + ts));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const provided = (m[2] || "").trim().toLowerCase();
    if (expected.length !== provided.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
  } catch (e) { console.error("retell sig verify threw", String(e)); return false; }
}
async function retellGate(req: Request, label: string): Promise<{ reject: Response | null }> {
  let rawBody = "";
  try { rawBody = await req.clone().text(); } catch { rawBody = ""; }
  const valid = await retellSigValid(rawBody, req.headers.get("x-retell-signature"));
  console.log(`retell-sig ${label}: ${valid ? "PASS" : "FAIL"}`);
  if (!valid && RETELL_SIG_ENFORCE) {
    return { reject: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  }
  return { reject: null };
}

function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
function truthy(v: unknown) {
  if (v === true) return true;
  if (typeof v === "string") return ["true", "yes", "1", "urgent", "emergency"].includes(v.trim().toLowerCase());
  return false;
}
function esc(s: string) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mister", "dr", "sir", "madam", "mx"]);
function nameTokens(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t && !HONORIFICS.has(t));
}

const FAIL = "I'm sorry, I had trouble saving that. Let me try again. What would you like me to pass along?";

async function sendMessageEmail(opts: {
  to: string; cc: string | null; fromAddr: string; business: string; who: string; callback: string;
  messageText: string; tz: string; isEmergency: boolean; forName: string | null;
}) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = String(opts.fromAddr || "").trim();
  if (!key || !opts.to || !from) { if (!from) console.error("message alert: no tenant from-address; message saved, email skipped"); return; }
  const when = new Intl.DateTimeFormat("en-US", { timeZone: opts.tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
  const callback = opts.callback || "(no callback number captured)";
  const subject = opts.isEmergency
    ? `URGENT call for ${opts.business}: ${opts.who}`
    : opts.forName ? `New message for ${opts.forName} at ${opts.business}` : `New message for ${opts.business}: ${opts.who}`;
  const forLine = opts.forName ? `For: ${opts.forName}\n` : "";
  const lead = opts.isEmergency ? "Donna flagged an urgent call." : "Donna took a message.";
  const text = `${lead}\n\n` + forLine + `From: ${opts.who}\n` + `Callback: ${callback}\n` + `When: ${when}\n\n` + `Message:\n${opts.messageText}\n\n` + (opts.isEmergency ? "Please call them back as soon as possible." : "");
  const banner = opts.isEmergency
    ? `<p style="background:#b00020;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;margin:0 0 14px">URGENT call flagged by Donna</p>`
    : `<p style="background:#0f2740;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;margin:0 0 14px">New message from Donna</p>`;
  const forRow = opts.forName ? `<tr><td style="padding:4px 12px 4px 0;color:#555">For</td><td><b>${esc(opts.forName)}</b></td></tr>` : "";
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px">` + banner +
    `<table style="border-collapse:collapse;font-size:15px">` + forRow +
    `<tr><td style="padding:4px 12px 4px 0;color:#555">From</td><td><b>${esc(opts.who)}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#555">Callback</td><td><b>${esc(callback)}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0;color:#555">When</td><td>${esc(when)}</td></tr>` +
    `</table>` + `<p style="margin:14px 0 4px;color:#555">Message</p>` +
    `<p style="margin:0 0 16px;padding:12px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap">${esc(opts.messageText)}</p>` +
    (opts.isEmergency ? `<p style="margin:0;color:#555">Please call them back as soon as possible.</p>` : "") + `</div>`;
  const payload: any = { from, to: [opts.to], subject, text, html };
  if (opts.cc) payload.cc = [opts.cc];
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) console.error("message email failed", res.status, await res.text().catch(() => ""));
  } catch (e) { console.error("message email threw", String(e)); }
}

async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
async function callFn(fn: string, body: any): Promise<any> {
  try { const r = await fetch(`${SELF}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(body) }); return await r.json().catch(() => ({})); } catch { return {}; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ result: "" }, 405);
  const _gate = await retellGate(req, "take-message");
  if (_gate.reject) return _gate.reject;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ result: FAIL }); }

  const call = body?.call ?? {};
  const args = body?.args ?? {};
  const toNumber = call?.to_number;
  const fromNumber = call?.from_number ?? "";
  const retellId = call?.call_id ?? null;

  const callerName = String(args?.caller_name ?? args?.name ?? "").trim();
  const callbackNumber = (String(args?.callback_number ?? args?.phone ?? "").trim() || fromNumber || "");
  const messageText = String(args?.message ?? args?.note ?? "").trim();
  const language = String(args?.language ?? "").trim() || null;
  const isEmergency = truthy(args?.is_emergency ?? args?.emergency ?? args?.urgent);
  const forName = String(args?.for_name ?? args?.for_person ?? args?.recipient ?? "").trim() || null;
  const addressArg = String(args?.address ?? args?.service_address ?? "").trim();

  if (!toNumber || !messageText) return json({ result: FAIL });

  const { data: asst } = await supabase
    .from("assistants").select("account_id, routing, accounts(name, settings, industry)")
    .eq("twilio_number", toNumber).maybeSingle();
  if (!asst) return json({ result: FAIL });

  const acct: any = (asst as any).accounts || {};
  const settings = acct.settings || {};
  const routing: any = (asst as any).routing || {};
  const generalBox = String(settings.alert_email || "").trim();
  const directory = Array.isArray(routing.directory) ? routing.directory : [];
  const copyStylistMsgs = ((settings.notify || {}).copy_stylist_messages) !== false;

  let personEmail = "", notifyUserId: string | null = null;
  if (forName) {
    const want = nameTokens(forName);
    if (want.length) {
      const { data: staff } = await supabase.from("users").select("id, full_name, email").eq("account_id", asst.account_id);
      const su = (staff || []).find((u: any) => { const have = nameTokens(u.full_name); return have.some((h: string) => want.includes(h)); });
      if (su) { personEmail = String((su as any).email || "").trim(); notifyUserId = (su as any).id; }
      if (!personEmail) {
        const target = directory.find((p: any) => { const have = nameTokens(p?.name); return have.some((h: string) => want.includes(h)); });
        personEmail = String(target?.email || "").trim();
      }
    }
  }

  let callRowId: string | null = null;
  if (retellId) {
    const { data: c } = await supabase.from("calls").select("id").eq("twilio_call_sid", retellId).maybeSingle();
    callRowId = c?.id ?? null;
  }

  const who = callerName || "A caller";
  const num = callbackNumber ? ` (callback: ${callbackNumber})` : "";
  const forTag = forName ? `(For ${forName}) ` : "";
  const composed = `${isEmergency ? "[URGENT] " : ""}${forTag}Message from ${who}${num}: ${messageText}`;

  const { error } = await supabase
    .from("messages")
    .insert({ account_id: asst.account_id, body: composed, language, call_id: callRowId, is_emergency: isEmergency, notify_user_id: notifyUserId });
  if (error) return json({ result: "I'm sorry, I had trouble saving that message." });

  if (callRowId) {
    const patch: Record<string, unknown> = { outcome: "message_taken" };
    if (language) patch.language = language;
    await supabase.from("calls").update(patch).eq("id", callRowId);
  }

  const to = personEmail || generalBox;
  const cc = copyStylistMsgs && personEmail && generalBox && personEmail.toLowerCase() !== generalBox.toLowerCase() ? generalBox : null;

  if (to) {
    const p = sendMessageEmail({
      to, cc,
      fromAddr: String(settings.email_reply_from || "Donna <no-reply@client.sidekicklogistics.com>").trim(),
      business: acct.name || "your business",
      who, callback: callbackNumber, messageText,
      tz: String(settings.timezone || "America/Chicago"),
      isEmergency, forName,
    });
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(p); } catch { /* fire and forget */ }
  }

  // ---- Contractor after-hours: open an emergency job, then prepay link or page the on-call tech ----
  const ctr: any = settings.contractor || {};
  if (isEmergency && String(settings.industry || acct.industry || "") === "contractor" && ctr.after_hours_enabled === true) {
    try {
      const { data: owner } = await supabase.from("users").select("id, full_name, phone").eq("account_id", asst.account_id).eq("role", "owner").limit(1).maybeSingle();
      const pagePhone = String(ctr.after_hours_page_phone || (owner as any)?.phone || "").trim();
      const addrMatch = messageText.match(/(\d{2,6}\s+[^,.;]{3,60}(?:,\s*[^,.;]{2,40}){0,2})/);
      const address = addressArg || (addrMatch ? addrMatch[1].trim() : null);
      const { data: job } = await supabase.from("jobs").insert({ account_id: asst.account_id, kind: "emergency", status: "scheduled", priority: "emergency", title: "After-hours call", customer_name: callerName || null, customer_phone: callbackNumber || null, address, notes: messageText, assigned_user_id: (owner as any)?.id || null, scheduled_at: new Date().toISOString() }).select("id").maybeSingle();
      const fee = Number(ctr.after_hours_fee_cents || 0);
      // Prepay only works when the shop can actually take cards (their Stripe is live); otherwise page right away and the fee goes on the invoice.
      let cardsOn = settings.payments?.enabled === true;
      if (cardsOn) { const { data: pa } = await supabase.from("payment_accounts").select("charges_enabled").eq("account_id", asst.account_id).maybeSingle(); cardsOn = (pa as any)?.charges_enabled === true; }
      const prepay = ctr.after_hours_prepay === true && fee > 0 && cardsOn && settings.sms?.enabled === true && !!callbackNumber && !!(owner as any)?.id;
      const business = acct.name || "us";
      if (prepay) {
        const inv = await callFn("payments", { action: "invoice_create", user_id: (owner as any).id, job_id: job?.id || null, customer_name: callerName || null, customer_phone: callbackNumber, service_address: address, lines: [{ desc: "After-hours service fee (applied to your visit)", unit_cents: fee, kind: "service" }], notes: "Paid before dispatch. This amount is credited toward the visit." });
        if (inv?.ok) {
          const sent = await callFn("payments", { action: "invoice_send", user_id: (owner as any).id, id: inv.invoice.id });
          if (sent?.ok) {
            return json({ result: `I've texted ${callbackNumber === fromNumber ? "this number" : callbackNumber} a secure link to pay the ${money(fee)} after-hours fee; it's applied to your visit. The moment it's paid, the on-call technician is paged and will call you back within about fifteen minutes. Is there anything else you'd like them to know?` });
          }
        }
        // fall through to paging if the link couldn't go out
      }
      if (pagePhone) {
        // On-call ladder: first rung now, next rung if nobody acknowledges within the shop's window (oncall.sweep).
        await callFn("oncall", { action: "page", account_id: asst.account_id, job_id: job?.id || null, message: `${who}${callbackNumber ? " " + callbackNumber : ""}${address ? " at " + address : ""}. ${messageText.slice(0, 300)}${fee > 0 ? ` (after-hours fee ${money(fee)} goes on the invoice)` : ""}. Call them back now.` });
        return json({ result: `I've paged the on-call technician with your address and the problem. Expect a call back within about fifteen minutes${fee > 0 ? `; the after-hours fee is ${money(fee)} on top of the regular price` : (Number(ctr.after_hours_multiplier || 0) > 1 ? `; after-hours work is billed at ${ctr.after_hours_multiplier} times the regular price` : "")}. Is there anything else you'd like them to know?` });
      }
    } catch (e) { console.error("after-hours branch", String(e)); }
  }

  return json({
    result: isEmergency
      ? "I've flagged this as urgent and saved it so someone can call you back as soon as possible. I'm not able to connect a live person right now. Is there anything else I can help with?"
      : "Got it. I've saved your message and someone will follow up with you. Is there anything else I can help with?",
  });
});
