import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// msg-quick — deterministic text replies for clients who have an appointment.
// Called by msg-inbound BEFORE the LLM (msg-brain) for every inbound text, on both the
// shared reminders number and a tenant's own number. Handles, without a model:
//   C / yes            -> confirm the next appointment
//   R / reschedule     -> offer that stylist's next open times for the same service, numbered; a digit moves it
//   cancel             -> ask YES/NO, then cancel
//   running late (+N)  -> note it on the appointment, text the stylist, email the owner
//   when is my appt    -> read back upcoming bookings
// Multi-step state lives in conversations.pending (short-lived). Anything else returns handled:false
// so msg-inbound can hand the text to msg-brain. Service-role only.
// Body: { account_id, from, body, conversation_id?, send? (default true: send the reply and log it), two_way? (reply from the tenant number; msg-send gates it) }

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const BOOK_BASE = "https://donna-dashboard-three.vercel.app";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const PENDING_MIN = 90;

const digits = (s: string) => (String(s || "").match(/\d/g) || []).join("");
const last10 = (s: string) => digits(s).slice(-10);
function firstName(n: string): string { return String(n || "").trim().split(/\s+/)[0] || ""; }
function serviceOf(title: string): string { const m = /^(.*?)\s+with\s+/i.exec(String(title || "")); return (m ? m[1] : String(title || "")).trim(); }
function whenLabel(iso: string, tz: string): string { const d = new Date(iso); const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d); const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d); return `${day} at ${time}`; }
function shortLabel(iso: string, tz: string): string { const d = new Date(iso); const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d); const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d); return `${day} ${time}`; }
function ymd(d: Date, tz: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function hhmm(iso: string, tz: string): string { return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)).replace(/^24/, "00"); }
function minutesOfDay(iso: string, tz: string): number { const [h, m] = hhmm(iso, tz).split(":").map(Number); return h * 60 + m; }

async function sendSms(accountId: string, to: string, text: string, twoWay = false): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body: text, ...(twoWay ? { two_way: true } : {}) }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
async function sendEmail(from: string, to: string, subject: string, text: string) {
  if (!RESEND_KEY || !from || !to) return;
  try { await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) }); } catch { /* */ }
}
async function internal(fn: string, payload: unknown): Promise<any> {
  try { const r = await fetch(`${SELF}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(payload) }); return await r.json().catch(() => null); } catch { return null; }
}

// Upcoming appointments for this phone at this business (by contact, then by digits in notes).
async function upcoming(accountId: string, phone: string) {
  const p10 = last10(phone);
  const { data: cs } = await supabase.from("contacts").select("id, name, preferred_name").eq("account_id", accountId).ilike("phone", "%" + p10);
  const ids = (cs || []).map((c: any) => c.id);
  const since = new Date(Date.now() - 3 * 3600e3).toISOString();
  const { data: appts } = await supabase.from("appointments").select("id, title, starts_at, ends_at, user_id, contact_id, notes, confirmed_at, appointment_type_id, late_minutes").eq("account_id", accountId).in("status", ["scheduled", "confirmed"]).gt("starts_at", since).order("starts_at", { ascending: true }).limit(40);
  const mine = (appts || []).filter((a: any) => (a.contact_id && ids.includes(a.contact_id)) || (p10.length === 10 && digits(a.notes || "").includes(p10)));
  const uids = [...new Set(mine.map((a: any) => a.user_id).filter(Boolean))];
  const names: Record<string, any> = {};
  if (uids.length) { const { data: us } = await supabase.from("users").select("id, full_name, phone, email").in("id", uids); (us || []).forEach((u: any) => { names[u.id] = u; }); }
  const contact = (cs || [])[0] || null;
  return { mine: mine.map((a: any) => ({ ...a, stylist: a.user_id ? firstName(names[a.user_id]?.full_name || "") : "", stylistRow: a.user_id ? names[a.user_id] : null })), contact };
}
const describe = (a: any, tz: string) => `${serviceOf(a.title) || "appointment"}${a.stylist ? " with " + a.stylist : ""} on ${whenLabel(a.starts_at, tz)}`;

// Next open times for the same person and duration, spread over the coming days, skipping the current slot.
async function options(accountId: string, a: any, tz: string, skip: string[] = []): Promise<{ iso: string; label: string }[]> {
  const dur = a.ends_at ? Math.max(15, Math.round((new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000)) : 45;
  const out: { iso: string; label: string }[] = [];
  const nowMs = Date.now() + 30 * 60000;
  const prefMin = minutesOfDay(a.starts_at, tz);
  let cursor = new Date();
  for (let i = 0; i < 12 && out.length < 4; i++) {
    const day = ymd(cursor, tz);
    const { data: rows } = a.user_id
      ? await supabase.rpc("donna_available_slots_user", { p_account_id: accountId, p_user_id: a.user_id, p_date: day, p_tz: tz, p_slot_min: 30, p_dur_min: dur })
      : await supabase.rpc("donna_available_slots", { p_account_id: accountId, p_date: day, p_tz: tz, p_slot_min: 30, p_dur_min: dur });
    const slots = (rows || []).map((r: any) => new Date(r.slot).toISOString()).filter((iso: string) => new Date(iso).getTime() > nowMs && iso !== new Date(a.starts_at).toISOString() && !skip.includes(iso));
    if (slots.length) {
      // closest to the client's usual time of day first, then one more from that day if it is the first day
      slots.sort((x: string, y: string) => Math.abs(minutesOfDay(x, tz) - prefMin) - Math.abs(minutesOfDay(y, tz) - prefMin));
      out.push({ iso: slots[0], label: shortLabel(slots[0], tz) });
      if (out.length < 4 && slots.length > 2 && i < 2) out.push({ iso: slots[Math.floor(slots.length / 2)], label: shortLabel(slots[Math.floor(slots.length / 2)], tz) });
    }
    cursor = new Date(cursor.getTime() + 864e5);
  }
  return out.slice(0, 4);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ handled: false }, 405);
  if ((req.headers.get("Authorization") || "") !== `Bearer ${SERVICE_ROLE}`) {
    const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
    if (!(sec as any)?.value || (req.headers.get("x-cron-secret") || "") !== (sec as any).value) return json({ handled: false, reason: "forbidden" }, 403);
  }
  let body: any = {}; try { body = await req.json(); } catch { return json({ handled: false }); }
  const accountId = String(body.account_id || "").trim();
  const from = String(body.from || "").trim();
  const text = String(body.body || "").trim();
  const conversationId = body.conversation_id ? String(body.conversation_id) : null;
  const doSend = body.send !== false;
  // v5: replies in a conversation on the tenant's own number are two-way sends (msg-send enforces enabled + verified);
  // the stylist heads-up below stays a notification (toll-free).
  const twoWay = body.two_way === true;
  if (!accountId || !from || !text) return json({ handled: false });

  const { data: acct } = await supabase.from("accounts").select("name, settings, booking_slug").eq("id", accountId).maybeSingle();
  const settings: any = acct?.settings || {};
  const tz = String(settings.timezone || "America/Chicago");
  const business = acct?.name || "us";
  const emailFrom = String(settings.email_reply_from || `${business} <no-reply@client.sidekicklogistics.com>`).trim();
  const ownerBox = String(settings.alert_email || settings.escalation_email || "").trim();
  const bookUrl = (acct as any)?.booking_slug ? `${BOOK_BASE}/book/${(acct as any).booking_slug}` : `${BOOK_BASE}/book.html?a=${accountId}`;

  // Pending state
  let pending: any = null; let convoId = conversationId;
  if (!convoId) {
    const { data: cv } = await supabase.from("conversations").select("id, pending").eq("account_id", accountId).eq("channel", "sms").eq("customer_identifier", from).maybeSingle();
    if (cv) { convoId = cv.id; pending = (cv as any).pending || null; }
    else { const { data: nc } = await supabase.from("conversations").insert({ account_id: accountId, channel: "sms", customer_identifier: from, last_inbound_at: new Date().toISOString(), status: "active" }).select("id").maybeSingle(); convoId = (nc as any)?.id || null; }
  }
  else { const { data: cv } = await supabase.from("conversations").select("pending").eq("id", convoId).maybeSingle(); pending = (cv as any)?.pending || null; }
  if (pending && pending.expires_at && new Date(pending.expires_at).getTime() < Date.now()) pending = null;
  const setPending = async (p: any | null) => { if (!convoId) return; await supabase.from("conversations").update({ pending: p ? { ...p, expires_at: new Date(Date.now() + PENDING_MIN * 60000).toISOString() } : null }).eq("id", convoId); };

  const { mine, contact } = await upcoming(accountId, from);
  const low = text.toLowerCase().replace(/[.!?]+$/, "").trim();
  const numM = /^\s*(\d{1,2})\s*$/.exec(low); const num = numM ? Number(numM[1]) : null;

  const reply = async (msg: string, extra: Record<string, unknown> = {}) => {
    if (doSend) {
      const ok = await sendSms(accountId, from, msg, twoWay);
      if (convoId) {
        await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: convoId, direction: "outbound", actor: "donna", channel: "sms", body: msg, status: ok ? "sent" : "failed" });
        await supabase.from("conversations").update({ status: "active", last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", convoId);
      }
    }
    return json({ handled: true, reply: msg, ...extra });
  };

  // ---- Pending flows ----
  if (pending?.kind === "which") {
    const list: any[] = pending.appointments || [];
    if (num && list[num - 1]) {
      const a = mine.find((x: any) => x.id === list[num - 1].id) || list[num - 1];
      await setPending(null);
      if (pending.next === "cancel") { await setPending({ kind: "cancel", appointment_id: a.id, label: describe(a, tz) }); return reply(`Cancel your ${describe(a, tz)}? Reply YES to cancel or NO to keep it.`); }
      const opts = await options(accountId, a, tz);
      if (!opts.length) return reply(`I don't see another opening for ${a.stylist || "that"} in the next couple of weeks. Give us a call and we'll work something out.`);
      await setPending({ kind: "pick", appointment_id: a.id, options: opts.map((o) => o.iso), label: describe(a, tz) });
      return reply(`I can move your ${serviceOf(a.title) || "appointment"}${a.stylist ? " with " + a.stylist : ""} to:\n${opts.map((o, i) => `${i + 1}) ${o.label}`).join("\n")}\nReply with a number, or MORE for other times.`);
    }
    await setPending(null); // fall through
  }
  if (pending?.kind === "pick") {
    const opts: string[] = pending.options || [];
    if (num && opts[num - 1]) {
      const iso = opts[num - 1];
      const r = await internal("donna-reschedule", { appointment_id: pending.appointment_id, new_date: ymd(new Date(iso), tz), new_time: hhmm(iso, tz), tz, silent: true });
      await setPending(null);
      if (r?.ok) return reply(`Done. You're moved to ${r.when_label}. See you then!`, { moved: true });
      if (r?.reason === "slot_taken" || r?.reason === "calendar_busy") return reply(`That one just got taken. Reply R and I'll send fresh times.`);
      return reply(`I couldn't move that just now. Give us a call and we'll sort it out.`);
    }
    if (/^(more|other|others|different|none)\b/.test(low)) {
      const a = mine.find((x: any) => x.id === pending.appointment_id);
      if (a) { const opts2 = await options(accountId, a, tz, pending.shown || opts); if (opts2.length) { await setPending({ kind: "pick", appointment_id: a.id, options: opts2.map((o) => o.iso), shown: [...(pending.shown || []), ...opts, ...opts2.map((o) => o.iso)], label: pending.label }); return reply(`Other times:\n${opts2.map((o, i) => `${i + 1}) ${o.label}`).join("\n")}\nReply with a number.`); } }
      await setPending(null); return reply(`Those are the openings I have for now. Call us and we'll find something that works.`);
    }
    if (/^(no|cancel|never ?mind|nevermind|stop|keep)\b/.test(low)) { await setPending(null); return reply(`No problem, your appointment stays as is.`); }
    // anything else: fall through to normal handling
    await setPending(null);
  }
  if (pending?.kind === "cancel") {
    if (/^(y|yes|yeah|yep|yup|si|sí|confirm|cancel it|ok|okay)\b/.test(low)) {
      const r = await internal("donna-cancel", { appointment_id: pending.appointment_id, silent: true });
      await setPending(null);
      if (r?.ok) return reply(`Cancelled your ${pending.label}. When you're ready to rebook: ${bookUrl} or just text BOOK.`, { cancelled: true });
      return reply(`I couldn't cancel that just now. Give us a call and we'll take care of it.`);
    }
    if (/^(n|no|nope|keep|nevermind|never mind)\b/.test(low)) { await setPending(null); return reply(`Got it, your appointment stays as is. See you then!`); }
    await setPending(null);
  }
  if (pending?.kind === "late") {
    const m = /(\d{1,3})/.exec(low);
    if (m) { const a = mine.find((x: any) => x.id === pending.appointment_id); await setPending(null); if (a) return lateFlow(a, Number(m[1])); }
    await setPending(null);
  }

  async function lateFlow(a: any, minutes: number) {
    await supabase.from("appointments").update({ late_minutes: minutes, late_notified_at: new Date().toISOString() }).eq("id", a.id);
    const who = contact ? (String(contact.preferred_name || contact.name || "").trim() || from) : from;
    const svc = serviceOf(a.title) || "appointment";
    const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(a.starts_at));
    const stylistRow = a.stylistRow;
    if (stylistRow?.phone) await sendSms(accountId, stylistRow.phone, `Heads up from Donna: ${who} (${svc}, ${t}) is running about ${minutes} min late.`);
    if (ownerBox) await sendEmail(emailFrom, ownerBox, `${who} is running ${minutes} min late`, `${who} texted that they are running about ${minutes} minutes late for their ${svc}${a.stylist ? " with " + a.stylist : ""} at ${t}.`);
    const base = `No problem, ${a.stylist ? a.stylist + " knows" : "we know"} you're running about ${minutes} minutes late. Come when you can.`;
    return reply(minutes >= 20 ? `${base} If you'd rather move it to another time, reply R.` : base, { late: minutes });
  }

  // ---- Fresh intents ----
  const isConfirm = /^(c|y|yes|yep|yeah|yup|confirm|confirmed|confirmo|ok|okay|sure|si|sí|see you then|sounds good|great|perfect|👍)\b/.test(low) || low === "c";
  const isChange = /\b(resched|reschedule|move|change|different time|another time|push|later|earlier|can'?t make|cannot make|won'?t make|not going to make)\b/.test(low) || low === "r";
  const isCancel = /\bcancel/.test(low) && !/\bdon'?t cancel|not cancel/.test(low);
  const isLate = /\b(late|running behind|behind schedule|stuck in traffic|on my way|omw|few minutes|couple minutes)\b/.test(low);
  const isWhen = /\b(when|what time|what day|do i have|appointment\??$|my appointment|am i booked|confirm my)\b/.test(low) && !isChange && !isCancel;

  if (!mine.length) {
    if (isWhen || isConfirm || isChange || isCancel || isLate) {
      if (isConfirm && low.length <= 3) return json({ handled: false });
      return reply(`I don't see an upcoming appointment under this number at ${business}. Want to book one? ${bookUrl}`);
    }
    return json({ handled: false });
  }

  const next = mine[0];
  const today = ymd(new Date(), tz);

  if (isLate && !isCancel && !isChange) {
    const todays = mine.filter((a: any) => ymd(new Date(a.starts_at), tz) === today);
    const a = todays[0] || next;
    const m = /(\d{1,3})\s*(min|mins|minutes)?/.exec(low);
    if (m && Number(m[1]) > 0 && Number(m[1]) < 240) return lateFlow(a, Number(m[1]));
    await setPending({ kind: "late", appointment_id: a.id });
    return reply(`No worries. About how many minutes? Reply with a number and I'll let ${a.stylist || "the team"} know.`);
  }

  if (isCancel) {
    if (mine.length > 1) { await setPending({ kind: "which", next: "cancel", appointments: mine.slice(0, 4).map((a: any) => ({ id: a.id })) }); return reply(`Which one?\n${mine.slice(0, 4).map((a: any, i: number) => `${i + 1}) ${describe(a, tz)}`).join("\n")}\nReply with a number.`); }
    await setPending({ kind: "cancel", appointment_id: next.id, label: describe(next, tz) });
    return reply(`Cancel your ${describe(next, tz)}? Reply YES to cancel or NO to keep it.`);
  }

  if (isChange) {
    if (mine.length > 1) { await setPending({ kind: "which", next: "reschedule", appointments: mine.slice(0, 4).map((a: any) => ({ id: a.id })) }); return reply(`Which one would you like to move?\n${mine.slice(0, 4).map((a: any, i: number) => `${i + 1}) ${describe(a, tz)}`).join("\n")}\nReply with a number.`); }
    const opts = await options(accountId, next, tz);
    if (!opts.length) return reply(`I don't see another opening for ${next.stylist || "that"} in the next couple of weeks. Give us a call and we'll work something out.`);
    await setPending({ kind: "pick", appointment_id: next.id, options: opts.map((o) => o.iso), label: describe(next, tz) });
    return reply(`I can move your ${serviceOf(next.title) || "appointment"}${next.stylist ? " with " + next.stylist : ""} to:\n${opts.map((o, i) => `${i + 1}) ${o.label}`).join("\n")}\nReply with a number, or MORE for other times.`);
  }

  if (isConfirm) {
    if (!next.confirmed_at) await supabase.from("appointments").update({ confirmed_at: new Date().toISOString() }).eq("id", next.id);
    return reply(`Thanks! You're confirmed for your ${describe(next, tz)}. See you then!`, { confirmed: true });
  }

  if (isWhen) {
    const list = mine.slice(0, 3).map((a: any) => describe(a, tz));
    return reply(mine.length === 1 ? `You have a ${list[0]}. Reply C to confirm or R to reschedule.` : `You have ${mine.length} coming up: ${list.join("; ")}. Reply R to move one or CANCEL to cancel one.`);
  }

  return json({ handled: false });
});
