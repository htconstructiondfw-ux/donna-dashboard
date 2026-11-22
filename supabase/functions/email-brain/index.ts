import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna email brain. The CONTACT record is the single shared per-customer memory
// across phone and email AND across all of a customer's email threads. Handles
// scheduling too (opt-in only). Escalations win.
// Salon team accounts (salon + Pro/Enterprise) book a SPECIFIC provider: Donna
// resolves which provider the customer named, checks that provider's own
// availability, and books them through staff-book, mirroring the phone flow.
// v31: knowledge search matches the phone (meaning + keyword search together, up to 6 passages),
// and for accounts with properties/communities it works out the writer's community first
// (property contact by email, or the community named in the thread). When the community is
// unknown, knowledge is grouped per community and Donna is told to ask instead of guessing.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const MODEL = "claude-sonnet-4-5-20250929";
const DASHBOARD_URL = "https://donna-dashboard-three.vercel.app";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const SIM_THRESHOLD = 0.78;
const HISTORY_WINDOW = 40;
const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });

async function embed(text: string): Promise<string | null> {
  try {
    const session = new (globalThis as any).Supabase.ai.Session("gte-small");
    const emb: number[] = await session.run(text, { mean_pool: true, normalize: true });
    if (!Array.isArray(emb) || !emb.length) return null;
    return "[" + emb.join(",") + "]";
  } catch { return null; }
}
const squash = (t: string) => String(t || "").replace(/\s+/g, " ").trim();
// One scope (a property/community, or the whole account when propertyId is null): meaning search and
// keyword search run together, results interleaved and de-duplicated.
async function searchScope(accountId: string, query: string, vec: string | null, propertyId: string | null, max: number): Promise<string[]> {
  const [sem, kw] = await Promise.all([
    (async () => {
      if (!vec) return [] as any[];
      const { data } = await supabase.rpc("match_knowledge", { p_account_id: accountId, p_query: vec, p_count: 8, p_property_id: propertyId });
      return (data ?? []).filter((r: any) => (r.similarity ?? 0) >= SIM_THRESHOLD);
    })().catch(() => [] as any[]),
    (async () => {
      const { data } = await supabase.rpc("donna_search_knowledge_any", { p_account_id: accountId, p_query: query.slice(0, 600), p_limit: 5, p_property_id: propertyId });
      return data ?? [];
    })().catch(() => [] as any[]),
  ]);
  const out: string[] = []; const seen = new Set<string>();
  const add = (r: any) => { if (!r || out.length >= max) return; const c = squash(r.content); const id = c.slice(0, 160); if (seen.has(id)) return; seen.add(id); out.push((r.title ? `${r.title}: ` : "") + c.slice(0, 1800)); };
  for (let i = 0; i < 8 && out.length < max; i++) { add(sem[i]); add(kw[i]); }
  return out;
}
const NAME_DROP = new Set(["residential", "community", "communities", "inc", "llc", "association", "hoa", "the", "owners", "homeowners", "property", "of", "at"]);
// Which property/community is this writer with? Their property contact record by email first, then a community named in the thread.
async function resolveProperty(accountId: string, emailAddr: string, text: string): Promise<{ props: any[]; chosen: any | null }> {
  const { data: props } = await supabase.from("properties").select("id, name").eq("account_id", accountId);
  const list = (props || []) as any[];
  if (!list.length) return { props: list, chosen: null };
  if (list.length === 1) return { props: list, chosen: list[0] };
  if (emailAddr && emailAddr.includes("@")) {
    const { data: pc } = await supabase.from("property_contacts").select("property_id").eq("account_id", accountId).ilike("email", emailAddr).limit(5);
    const ids = [...new Set(((pc || []) as any[]).map((r) => r.property_id).filter(Boolean))];
    if (ids.length === 1) { const hit = list.find((p) => p.id === ids[0]); if (hit) return { props: list, chosen: hit }; }
  }
  const low = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const core = (n: string) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !NAME_DROP.has(w)).join(" ");
  const hits = list.filter((p) => { const c = core(p.name); if (c.length < 4) return false; return low.includes(" " + c + " ") || low.includes(" " + c.replace(/parke$/, "park") + " "); });
  return { props: list, chosen: hits.length === 1 ? hits[0] : null };
}
async function callClaude(system: string, user: string, maxTokens = 1000): Promise<string | null> {
  if (!ANTHROPIC_KEY) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      });
      if (r.status === 200) {
        const j = await r.json().catch(() => ({}));
        const txt = Array.isArray(j?.content) ? (j.content.find((b: any) => b.type === "text")?.text ?? null) : null;
        if (txt) return txt;
      } else { console.error("claude non-200", r.status, (await r.text().catch(() => "")).slice(0, 300)); }
    } catch (e) { console.error("claude threw", String(e)); }
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
  }
  return null;
}
function parseJson(text: string): any | null {
  if (!text) return null;
  let t = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"); const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}
async function localize(text: string, lang: string): Promise<string> {
  const l = String(lang || "").trim().toLowerCase();
  if (!text || !l || l === "english" || l === "en") return text;
  const out = await callClaude(`Translate the message below into ${lang}. Keep it natural and warm, and preserve names, dates, times, links, phone numbers, and line breaks. If it is already in ${lang}, return it unchanged. Output only the translated message, nothing else.`, text, 700);
  return (out && out.trim().length > 1) ? out.trim() : text;
}
function firstNameOf(n: string): string { return String(n || "").trim().split(/\s+/)[0] || ""; }
function matchStylist(people: any[], raw: string): { match: any | null; ambiguous: boolean } {
  const q = String(raw || "").trim().toLowerCase();
  if (!q) return { match: null, ambiguous: false };
  const exact = people.filter((p) => String(p.full_name || "").trim().toLowerCase() === q || firstNameOf(p.full_name).toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], ambiguous: false };
  if (exact.length > 1) return { match: null, ambiguous: true };
  const starts = people.filter((p) => { const fn = firstNameOf(p.full_name).toLowerCase(); return String(p.full_name || "").trim().toLowerCase().startsWith(q) || (fn && q.startsWith(fn)); });
  if (starts.length === 1) return { match: starts[0], ambiguous: false };
  if (starts.length > 1) return { match: null, ambiguous: true };
  return { match: null, ambiguous: false };
}
function listNames(people: any[]): string {
  const names = people.map((p) => firstNameOf(p.full_name) || p.full_name).filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}
async function sendEmail(from: string, to: string, subject: string, text: string, replyTo?: string | null) {
  if (!RESEND_KEY || !from || !to) return null;
  try {
    const payload: any = { from, to: [to], subject, text };
    if (replyTo) payload.reply_to = replyTo;
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) { console.error("send failed", r.status, await r.text().catch(() => "")); return null; }
    const j = await r.json().catch(() => ({}));
    return j?.id || j?.data?.id || null;
  } catch (e) { console.error("send threw", String(e)); return null; }
}

function ymdInTz(d: Date, tz: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function weekdayShort(d: Date, tz: string): string { return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d); }
function fmtSlot(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  return `${day} at ${time}`;
}
async function gatherSlots(accountId: string, tz: string, dur: number, maxTotal = 5): Promise<{ iso: string; label: string }[]> {
  const out: { iso: string; label: string }[] = [];
  const nowMs = Date.now() + 20 * 60000;
  const todayYmd = ymdInTz(new Date(), tz);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  let cursor = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
  for (let i = 0; i < 10 && out.length < maxTotal; i++) {
    const wd = weekdayShort(cursor, tz);
    if (wd !== "Sat" && wd !== "Sun") {
      const ymd = ymdInTz(cursor, tz);
      const { data: rows } = await supabase.rpc("donna_available_slots", { p_account_id: accountId, p_date: ymd, p_tz: tz, p_slot_min: dur, p_dur_min: dur });
      const slots = (rows ?? []).map((r: any) => new Date(r.slot as string).toISOString()).filter((iso: string) => new Date(iso).getTime() > nowMs).sort();
      if (slots.length) {
        const picks = slots.length >= 2 ? [slots[0], slots[Math.floor(slots.length / 2)]] : [slots[0]];
        for (const iso of picks) { if (out.length < maxTotal) out.push({ iso, label: fmtSlot(iso, tz) }); }
      }
    }
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  return out;
}
// Per-provider open slots for salon team accounts. Relies on the provider's own
// bookable hours (so it does not skip weekends the way the account-level version does).
async function gatherSlotsForUser(accountId: string, userId: string, tz: string, dur: number, maxTotal = 5): Promise<{ iso: string; label: string }[]> {
  const out: { iso: string; label: string }[] = [];
  const nowMs = Date.now() + 20 * 60000;
  const todayYmd = ymdInTz(new Date(), tz);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  let cursor = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
  for (let i = 0; i < 14 && out.length < maxTotal; i++) {
    const ymd = ymdInTz(cursor, tz);
    const { data: rows } = await supabase.rpc("donna_available_slots_user", { p_account_id: accountId, p_user_id: userId, p_date: ymd, p_tz: tz, p_slot_min: dur, p_dur_min: dur });
    const slots = (rows ?? []).map((r: any) => new Date(r.slot as string).toISOString()).filter((iso: string) => new Date(iso).getTime() > nowMs).sort();
    if (slots.length) {
      const picks = slots.length >= 2 ? [slots[0], slots[Math.floor(slots.length / 2)]] : [slots[0]];
      for (const iso of picks) { if (out.length < maxTotal) out.push({ iso, label: fmtSlot(iso, tz) }); }
    }
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  return out;
}

const SYSTEM = `You are Donna, an email receptionist replying on behalf of a business. You write warm, concise, professional email replies to customers.

You are given the business name, any relevant business knowledge, what you already remember about this person, the recent conversation, the current date and timezone, the appointment formats this business offers, and the customer's latest email. Return STRICT JSON only, no markdown:
{"reply": "...", "escalate": false, "reason": "", "needs_scheduling": false, "action": "", "chosen_date": "", "chosen_time": "", "mode": "", "location": "", "waitlist": false, "language": "", "memory": "..."}

YOUR #1 JOB: Directly answer the customer's LATEST email. Read their latest message and answer exactly what they asked, specifically and in full, using the business knowledge and what you remember. Earlier messages in the thread are background context; they must NEVER pull you away from answering the current question. If their latest email asks what the business does, what it offers, pricing, hours, or any factual question, answer THAT, even if earlier in the thread the conversation was about something else.

Rules:
- Use ONLY the provided business knowledge for factual claims about the BUSINESS (hours, prices, services, what the business does, policies, location). NEVER invent or guess business facts. The provided knowledge is your source of truth: if it contains the answer, give that answer directly.
- Use what you remember about this person to continue their projects and requests accurately and to greet them by name. This memory is shared across all their email threads and phone calls, so rely on it even when they write from a brand-new thread or subject. Do NOT invent facts about them; only use what is in the memory or the conversation.
- If answering requires information you were not given, do not guess. Set "escalate" true, put a short note in "reason", and write "reply" as a brief warm holding message that you are checking with the team.
- SCHEDULING IS STRICTLY OPT-IN. Only schedule, mention availability, offer times, or suggest a call when the customer's LATEST email EXPLICITLY asks to book, reschedule, cancel, meet, talk, or get on a call, or is a direct reply inside an active scheduling thread you already started. Stating interest, describing a need, a project, or a problem (for example "we need inventory tracking" or "I'm looking into software") is NOT such a request: acknowledge it, answer from the knowledge, and stop. This rule governs the ENTIRE reply, especially the closing line. When the customer has not explicitly asked to meet or book, your reply must contain ZERO mention of calls, meetings, consultations, scheduling, availability, or times anywhere in it. Do NOT end by offering to "hop on a call," to "walk you through" something, to connect, or with your availability, and do NOT suggest a call "if useful." Instead, close warmly by inviting any further questions. Leave "needs_scheduling" false in all these cases. Do NOT invent available times in "reply"; when scheduling genuinely applies, the system supplies the real open times, so keep "reply" short and set "needs_scheduling" true.
- "action": set to "cancel" if the customer wants to cancel an existing appointment, or "reschedule" if they want to move an existing appointment to a different time; otherwise leave it empty. For a reschedule, put the NEW day and time in chosen_date and chosen_time once they commit to a specific one (if they have not named a new time yet, leave those empty and the system will offer open times), and keep needs_scheduling true. For a cancel, if they identify the appointment by date, put that date in chosen_date.
- "chosen_date" and "chosen_time": fill these ONLY when the customer has clearly committed to one specific day and time, including when they pick one you previously offered. Use YYYY-MM-DD for chosen_date and 24-hour HH:MM for chosen_time, resolved to the business timezone using the current date you are given. If they have not committed to a single specific time, leave both empty.
- "mode": the appointment format the customer wants, one of "phone", "video", or "onsite", chosen ONLY from the formats this business offers (listed below). Set it when booking a NEW appointment, and ALSO when the customer wants to CHANGE the format of an existing appointment while rescheduling (for example moving a phone call to an on-site visit). If the business offers just one format, use it. If several are offered and it is unclear which they want, leave "mode" empty and briefly ask which they prefer. For a video appointment you do NOT need to include a link; the system adds it.
- "location": for an onsite appointment only, the customer's address if they gave it; otherwise leave empty and ask for it in your reply. Empty for phone or video.
- "waitlist": set true ONLY when the customer asks to be put on the waitlist, asks to be told when a time opens up, or accepts a waitlist offer you made after a time they wanted was full. When you set it true, also fill "service" with the service they want (and "stylist" if this business has more than one provider and they named one), and put the specific date they are hoping for in "chosen_date" if they gave one. Do NOT set "needs_scheduling" true for a waitlist request. If a time the customer asked for is full and you are offering other times, you may also offer in your reply to add them to the waitlist for their preferred time.
- Keep the reply short and human. Sign as the business, not as an AI. No em dashes.
- "memory": return an updated profile of THIS person that persists across ALL their email threads and phone calls, so you always know them no matter which thread they write from. Capture durable content: who they are, their business, their role, and the SUBSTANCE of any ongoing project or request, including the specific requirements, decisions, constraints, and details they have shared, so you can continue accurately even after many messages or in a new thread. Do NOT record running commentary about the sales process, such as whether they have been sent or declined scheduling, how many times they asked something, or whether they committed to an appointment. Store real content (facts and project details), not a narrative about the exchange. Preserve everything already known (including from phone calls) and add anything new the customer stated. If nothing new, return the prior memory unchanged.
- LANGUAGE: detect the language of the customer's LATEST email and write your ENTIRE reply in that same language (for example, Spanish in means Spanish out). Put that language's English name (for example "Spanish", "French", or "English") in the "language" field.
- Write only the email body in "reply".`;

Deno.serve(async (req: Request) => {
  let body: any = {};
  try { body = await req.json(); } catch { return ok({ ok: false, reason: "bad_body" }); }
  const conversationId = body?.conversation_id;
  if (!conversationId) return ok({ ok: false, reason: "no_conversation" });

  const { data: convo } = await supabase.from("conversations").select("id, account_id, customer_identifier, customer_name, channel").eq("id", conversationId).maybeSingle();
  if (!convo || convo.channel !== "email") return ok({ ok: false, reason: "not_email_convo" });

  const { data: acct } = await supabase.from("accounts").select("name, settings, plan").eq("id", convo.account_id).maybeSingle();
  const settings: any = acct?.settings || {};
  const replyFrom = String(settings.email_reply_from || `${acct?.name || "Donna"} <no-reply@client.sidekicklogistics.com>`).trim();
  const escalationEmail = String(settings.escalation_email || settings.alert_email || "").trim();
  const autoSend = settings.email_auto_send === true;
  const schedulingEnabled = settings.scheduling_enabled !== false;
  const schedulingAuto = autoSend && (settings.scheduling_auto_send !== false);
  const tz = String(settings.timezone || "America/Chicago");
  const business = acct?.name || "the business";
  const plan = String((acct as any)?.plan || "starter");
  const salonTeam = settings?.features?.salon === true && (plan === "pro" || plan === "enterprise");
  const providerWord = String(settings.provider_label || "stylist");
  const notify: any = settings.notify || {};
  const generalBox = String(settings.alert_email || settings.escalation_email || "").trim();
  let bookablePeople: any[] = [];
  if (salonTeam) {
    const { data: bp } = await supabase.from("users").select("id, full_name").eq("account_id", convo.account_id).eq("is_bookable", true).order("created_at");
    bookablePeople = (bp || []) as any[];
  }

  const { data: typeRows } = await supabase.from("appointment_types").select("id, name, mode, default_duration_min").eq("account_id", convo.account_id).eq("is_active", true).order("created_at");
  const activeTypes = (typeRows || []) as any[];
  const dur = (activeTypes[0]?.default_duration_min) || 30;
  const modeLabel = (m: string) => m === "virtual" ? "video" : (m === "in_person" ? "on-site" : "phone");
  const typesList = activeTypes.map((t) => `${t.name} (${modeLabel(t.mode)})`).join(", ") || "phone";

  const emailAddr = String(convo.customer_identifier || "").trim();
  const { data: linkedContact } = (emailAddr && emailAddr.includes("@"))
    ? await supabase.from("contacts").select("id, name, preferred_name, phone, memory").eq("account_id", convo.account_id).ilike("email", emailAddr).maybeSingle()
    : { data: null } as any;
  const { data: memRow } = await supabase.from("email_memory").select("id, memory").eq("account_id", convo.account_id).ilike("email", emailAddr).maybeSingle();
  const priorMemory = String((linkedContact?.memory || memRow?.memory) || "").trim();

  const { data: msgs } = await supabase.from("conversation_messages").select("direction, actor, subject, body, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(HISTORY_WINDOW);
  const turns = (Array.isArray(msgs) ? msgs : []).slice().reverse();
  const lastInbound = [...turns].reverse().find((m: any) => m.direction === "inbound");
  if (!lastInbound) return ok({ ok: false, reason: "no_inbound" });

  const subject = String(lastInbound.subject || "").trim();
  const question = `${subject}\n${String(lastInbound.body || "").trim()}`.trim();
  const history = turns.map((m: any) => `${m.direction === "inbound" ? "Customer" : "Donna"}: ${String(m.body || "").trim()}`).join("\n\n");

  // Knowledge: work out the writer's community (if this business has several), then search like the phone does.
  let knowledge = ""; let communityNote = "";
  try {
    const customerText = turns.filter((m: any) => m.direction === "inbound").map((m: any) => `${String(m.subject || "")} ${String(m.body || "")}`).join("\n");
    const { props: propList, chosen: prop } = await resolveProperty(convo.account_id, emailAddr, `${customerText}\n${priorMemory}`);
    const qvec = await embed(question.slice(0, 1500));
    if (prop || !propList.length) {
      knowledge = (await searchScope(convo.account_id, question, qvec, prop ? prop.id : null, 6)).join("\n\n");
      if (prop && propList.length > 1) communityNote = `This business manages several communities. This customer is with ${prop.name}, and the knowledge above is for that community.\n\n`;
    } else {
      const parts: string[] = [];
      for (const p of propList.slice(0, 6)) {
        const rows = await searchScope(convo.account_id, question, qvec, p.id, 3);
        if (rows.length) parts.push(`For ${p.name} only:\n` + rows.join("\n\n"));
      }
      knowledge = parts.join("\n\n-----\n\n");
      communityNote = `This business manages several communities: ${propList.map((p) => p.name).join("; ")}. You do NOT know which one this customer lives in. The knowledge above is grouped by community, and rules differ between them. If the answer depends on the community, do not guess and do not give one community's rule: ask which community they live in and their address, and leave "escalate" false.\n\n`;
    }
  } catch (e) { console.error("knowledge search", String(e)); }

  const nowLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
  const todayYmd = ymdInTz(new Date(), tz);

  const salonNote = salonTeam
    ? `\nThis business has more than one ${providerWord}: ${bookablePeople.map((p) => p.full_name).join(", ")}. If the customer wants to book, you MUST know which ${providerWord} they want. Add two extra top-level fields to your JSON: "stylist" (the ${providerWord} the customer named, else empty) and "service" (the service they asked for, matched to the formats above, else empty). If the customer did NOT name a ${providerWord}, do NOT set needs_scheduling to true; instead ask in your reply which ${providerWord} they would like, listing: ${bookablePeople.map((p) => firstNameOf(p.full_name) || p.full_name).join(", ")}.\n`
    : "";

  const userMsg =
    `Business: ${business}\n\n` +
    `Relevant business knowledge:\n${knowledge || "(no saved information found for this question)"}\n\n` + communityNote +
    `What you remember about this person (${convo.customer_identifier}) from all past threads and phone calls:\n${priorMemory || "(nothing yet, this may be a new contact)"}\n\n` +
    `Conversation so far (BACKGROUND, the latest email below is what you answer):\n${history}\n\n` +
    `Current date and time: ${nowLabel} (today is ${todayYmd}), timezone ${tz}.\n` +
    `Appointment formats this business offers: ${typesList}.\n` + salonNote +
    `The customer's LATEST email ---\nSubject: ${subject || "(none)"}\nBody: ${String(lastInbound.body || "").trim()}\n--- end latest email.\n\nAnswer that latest email now as Donna.`;

  const raw = await callClaude(SYSTEM, userMsg);
  const parsed = raw ? parseJson(raw) : null;
  if (!parsed || !parsed.reply) {
    if (escalationEmail) await sendEmail(replyFrom, escalationEmail, `Donna needs you: email from ${convo.customer_identifier}`,
      `Donna could not draft a reply automatically to an email from ${convo.customer_identifier}.\n\nSubject: ${subject}\n\nMessage:\n${String(lastInbound.body || "").trim()}\n\nOpen your dashboard to reply: ${DASHBOARD_URL}`);
    await supabase.from("conversations").update({ status: "awaiting_staff", updated_at: new Date().toISOString() }).eq("id", conversationId);
    return ok({ ok: false, reason: "no_draft", escalated: true });
  }

  const memText = String(parsed.memory || "").trim();
  if (memText && memText !== priorMemory) {
    if (memRow?.id) await supabase.from("email_memory").update({ memory: memText, updated_at: new Date().toISOString() }).eq("id", memRow.id);
    else await supabase.from("email_memory").insert({ account_id: convo.account_id, email: emailAddr, memory: memText });
  }

  try {
    if (emailAddr && emailAddr.includes("@")) {
      const memForContact = memText || priorMemory || null;
      const firstRaw = String(convo.customer_name || "").trim().split(/\s+/)[0] || "";
      const cleanFirst = /^[\p{L}][\p{L}'’-]{1,19}$/u.test(firstRaw) ? firstRaw : "";
      if (linkedContact?.id) {
        const cpatch: any = { updated_at: new Date().toISOString() };
        if (memForContact) cpatch.memory = memForContact;
        if (!linkedContact.name && convo.customer_name) cpatch.name = convo.customer_name;
        if (!linkedContact.preferred_name && cleanFirst) cpatch.preferred_name = cleanFirst;
        await supabase.from("contacts").update(cpatch).eq("id", linkedContact.id);
      } else {
        await supabase.from("contacts").insert({
          account_id: convo.account_id, email: emailAddr,
          name: convo.customer_name || null, preferred_name: cleanFirst || null,
          memory: memForContact, source: "email", list_type: "normal",
          updated_at: new Date().toISOString(),
        });
      }
    }
  } catch (_e) { /* contact mirror is best-effort */ }

  const reply = String(parsed.reply).trim();
  const replyLang = String(parsed.language || "").trim();
  const escalate = parsed.escalate === true;
  const action = String(parsed.action || "").trim().toLowerCase();
  const replySubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject || "your message"}`;

  const rawMode = String(parsed.mode || "").trim().toLowerCase();
  let bookMode: string | null = /video|virtual/.test(rawMode) ? "virtual" : (/site|person|onsite/.test(rawMode) ? "in_person" : (/phone|call/.test(rawMode) ? "phone" : null));
  const hasMode = (m: string) => activeTypes.some((t) => t.mode === m);
  if (bookMode && !hasMode(bookMode)) bookMode = null;
  const bookTypeId = bookMode ? (activeTypes.find((t) => t.mode === bookMode)?.id || null) : null;
  const bookLocation = String(parsed.location || "").trim() || null;

  function localDate(iso: string): string { const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso)); const g = (t: string) => p.find((x) => x.type === t)!.value; return `${g("year")}-${g("month")}-${g("day")}`; }
  async function findAppts(dateHint: string): Promise<any[]> {
    const { data } = await supabase.from("appointments").select("id, starts_at").eq("account_id", convo.account_id).eq("status", "scheduled").gt("starts_at", new Date().toISOString()).ilike("customer_email", convo.customer_identifier).order("starts_at", { ascending: true }).limit(10);
    let mine = (data || []) as any[];
    if (dateHint) mine = mine.filter((a) => localDate(a.starts_at) === dateHint);
    return mine;
  }
  async function callDonnaCancel(id: string) { try { const r = await fetch(`${SELF}/donna-cancel`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ appointment_id: id, silent: true }) }); return await r.json().catch(() => null); } catch (_e) { return null; } }
  async function callDonnaReschedule(id: string, date: string, time: string, mode?: string | null, location?: string | null) { try { const b: any = { appointment_id: id, new_date: date, new_time: time, tz, silent: true }; if (mode) b.new_mode = mode; if (location) b.new_location = location; const r = await fetch(`${SELF}/donna-reschedule`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(b) }); return await r.json().catch(() => null); } catch (_e) { return null; } }
  async function callStaffBook(userId: string, startIso: string, typeId: string | null, durMin: number, mode: string) {
    try { const r = await fetch(`${SELF}/staff-book`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "book", account_id: convo.account_id, user_id: userId, tz, start_iso: startIso, type_id: typeId, dur_min: durMin, mode, client_name: convo.customer_name || "", customer_email: convo.customer_identifier, notes: "" }) }); return await r.json().catch(() => null); } catch (_e) { return null; }
  }

  async function sendAndRecord(bodyText: string) {
    bodyText = await localize(bodyText, replyLang);
    const provId = await sendEmail(replyFrom, convo.customer_identifier, replySubject, bodyText);
    await supabase.from("conversation_messages").insert({ account_id: convo.account_id, conversation_id: conversationId, direction: "outbound", actor: "donna", channel: "email", subject: replySubject, body: bodyText, provider_message_id: String(provId || ""), status: provId ? "sent" : "failed" });
    await supabase.from("conversations").update({ status: "active", last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", conversationId);
    if (notify.copy_auto_replies === true && generalBox && generalBox.toLowerCase() !== String(convo.customer_identifier || "").toLowerCase()) {
      await sendEmail(replyFrom, generalBox, `[Copy] ${replySubject}`, `Donna sent this reply to ${convo.customer_identifier}:\n\n${bodyText}`);
    }
    return provId;
  }
  async function draftForApproval(bodyText: string, pendingAction: any | null, escalated: boolean) {
    bodyText = await localize(bodyText, replyLang);
    await supabase.from("conversation_messages").update({ status: "superseded" }).eq("conversation_id", conversationId).eq("direction", "outbound").eq("status", "queued");
    const { data: draftMsg } = await supabase.from("conversation_messages").insert({ account_id: convo.account_id, conversation_id: conversationId, direction: "outbound", actor: "donna", channel: "email", subject: replySubject, body: bodyText, status: "queued" }).select("id").maybeSingle();
    await supabase.from("conversations").update({ status: "awaiting_staff", updated_at: new Date().toISOString() }).eq("id", conversationId);
    let replyToAddr: string | null = null;
    if (escalationEmail) {
      const { data: addrs } = await supabase.from("email_addresses").select("address, active").eq("account_id", convo.account_id);
      const active = (addrs || []).find((a: any) => a.active) || (addrs || [])[0];
      const inboundDomain = active?.address && active.address.includes("@") ? active.address.split("@")[1] : "";
      if (inboundDomain) {
        const token = crypto.randomUUID().replace(/-/g, "");
        const ins: any = { token, account_id: convo.account_id, conversation_id: conversationId, draft_message_id: draftMsg?.id || null, escalation_email: escalationEmail, state: "open" };
        if (pendingAction) ins.pending_action = pendingAction;
        await supabase.from("approval_tokens").insert(ins);
        replyToAddr = `approve-${token}@${inboundDomain}`;
      }
      const actLabel = pendingAction ? (pendingAction.type === "cancel" ? " and cancel the appointment" : pendingAction.type === "reschedule" ? " and move the appointment" : " and book the appointment") : "";
      const lead = escalated
        ? `Donna needs your input on an email from ${convo.customer_identifier}. She drafted a holding reply but couldn't fully answer.`
        : `Donna drafted a reply to an email from ${convo.customer_identifier}.${pendingAction ? " Approving will also apply the change." : ""}`;
      const howto = replyToAddr
        ? `To approve: reply \"approved\" and Donna sends it${actLabel}.\nTo change it: reply with the wording you want sent instead.\nTo skip it: reply \"no\" and nothing is sent${pendingAction ? " or changed" : ""}.\n\nPrefer the dashboard? ${DASHBOARD_URL}`
        : `Review, edit, and send it from your dashboard: ${DASHBOARD_URL}`;
      await sendEmail(replyFrom, escalationEmail,
        escalated ? `Donna needs you: ${subject || "customer email"}` : `Donna drafted a reply: ${subject || "customer email"}`,
        `${lead}\n\nCustomer wrote:\n${String(lastInbound.body || "").trim()}\n\nDonna's draft:\n${bodyText}\n\n${escalated && parsed.reason ? "What's needed: " + parsed.reason + "\n\n" : ""}${howto}`, replyToAddr);
    }
  }
  async function ownerHeadsUp(text: string, kind: "appt" | "stylist" = "appt") {
    const allow = kind === "stylist" ? (notify.copy_stylist_conversations !== false) : (notify.copy_appt_changes !== false);
    if (allow && escalationEmail) await sendEmail(replyFrom, escalationEmail, "Donna updated an appointment", `${text}\n\nSee it in your dashboard: ${DASHBOARD_URL}`);
  }
  async function callDonnaBook(p: { date: string; time: string }) {
    try {
      const r = await fetch(`${SELF}/donna-book`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ account_id: convo.account_id, tz, caller: convo.customer_name || "", phone: "", email: convo.customer_identifier, notes: "", language: null, conversation_id: conversationId, date: p.date, time: p.time, mode: bookMode, appointment_type_id: bookTypeId, location: bookLocation }),
      });
      return await r.json().catch(() => null);
    } catch (e) { console.error("donna-book call", String(e)); return null; }
  }
  const confirmText = (label: string) => `Great news, you're all set for ${label}. If you need to change anything, just reply to this email and I'll take care of it.\n\nBest,\n${business}`;
  const cancelText = (label: string) => `Done, I've cancelled your appointment on ${label}. If you'd like to rebook or there's anything else, just reply and I'll help.\n\nBest,\n${business}`;
  const rescheduleText = (oldL: string, newL: string) => `All set, I've moved your appointment from ${oldL} to ${newL}. If you need to change anything else, just reply.\n\nBest,\n${business}`;
  const notFoundText = () => `I don't see an upcoming appointment under this email address. If it was booked under a different email or name, reply and let me know and I'll sort it out.\n\nBest,\n${business}`;
  const whichText = (appts: any[], verb: string) => `I see more than one upcoming appointment under your email: ${appts.slice(0, 4).map((a) => fmtSlot(a.starts_at, tz)).join("; ")}. Which one would you like ${verb}?\n\nBest,\n${business}`;
  const askForTimeText = () => `Happy to help. What day and time generally work for you, and I'll check what's open on our end?\n\nBest,\n${business}`;
  async function writeProposal(slots: { iso: string; label: string }[], taken: boolean) {
    const list = slots.map((s) => `- ${s.label}`).join("\n");
    const sys = `You are Donna, an email receptionist for ${business}. Offer the customer these EXACT open times, written exactly as given, as a short friendly list. ${taken ? "Lead by letting them know the time they asked about just filled up, and after the list offer to add them to our waitlist so we can let them know the moment their preferred time opens up. " : ""}Ask them to reply with whichever works, and to suggest another day or time if none of these fit. Do NOT invent or alter times. Warm, concise, sign as the business. No em dashes. Output only the email body.`;
    const usr = `Open times to offer:\n${list}\n\nCustomer's latest message:\n${String(lastInbound.body || "").trim()}`;
    const drafted = await callClaude(sys, usr, 600);
    if (drafted && drafted.trim().length > 20) return drafted.trim();
    return `${taken ? "That time just filled up, sorry about that. " : ""}Here are some open times that work on our end:\n\n${list}\n\nReply with whichever one suits you, or suggest another day or time if none of these fit and I'll check.${taken ? " If you'd rather wait for your original time, I can add you to our waitlist and let you know the moment it opens up." : ""}\n\nBest,\n${business}`;
  }

  // ---- Waitlist: add this person to the waitlist for a time that's full ----
  if (schedulingEnabled && parsed.waitlist === true && !escalate) {
    let wlTarget: any = null;
    if (salonTeam && bookablePeople.length) { const { match } = matchStylist(bookablePeople, String(parsed.stylist || "")); wlTarget = match; }
    const wlDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.chosen_date || "").trim()) ? String(parsed.chosen_date).trim() : null;
    const wlSvc = String(parsed.service || "").trim() || null;
    await supabase.from("waitlist").insert({
      account_id: convo.account_id,
      contact_id: linkedContact?.id || null,
      customer_name: convo.customer_name || null,
      customer_email: emailAddr || null,
      customer_phone: (linkedContact as any)?.phone || null,
      provider_user_id: wlTarget?.id || null,
      service_label: wlSvc,
      earliest_date: wlDate,
      latest_date: wlDate,
      time_pref: String(parsed.chosen_time || "").trim() || null,
      note: null, source: "email", status: "active",
    });
    const whoWith = wlTarget ? ` with ${firstNameOf(wlTarget.full_name) || wlTarget.full_name}` : "";
    const forSvc = wlSvc ? ` for ${wlSvc}` : "";
    const first = firstNameOf(convo.customer_name || "") || "there";
    const wlBody = `Hi ${first},\n\nYou're on our waitlist${whoWith}${forSvc}. The moment a matching time opens up, I'll email you right away so you can grab it. If your plans change in the meantime, just let me know.\n\nBest,\n${business}`;
    if (schedulingAuto) { await sendAndRecord(wlBody); await ownerHeadsUp(`Donna added ${convo.customer_identifier} to the waitlist${whoWith}${forSvc}.`); return ok({ ok: true, mode: "waitlisted_auto" }); }
    await draftForApproval(wlBody, null, false);
    return ok({ ok: true, mode: "waitlisted_pending" });
  }

  // ---- Cancel / reschedule an existing appointment ----
  if (schedulingEnabled && (action === "cancel" || action === "reschedule") && !escalate) {
    const chosenDate = String(parsed.chosen_date || "").trim();
    const chosenTime = String(parsed.chosen_time || "").trim();
    const appts = await findAppts(action === "cancel" ? chosenDate : "");

    if (appts.length === 0) {
      if (schedulingAuto) { await sendAndRecord(notFoundText()); } else { await draftForApproval(notFoundText(), null, false); }
      return ok({ ok: true, mode: action + "_not_found" });
    }
    if (appts.length > 1) {
      const txt = whichText(appts, action === "cancel" ? "to cancel" : "to move");
      if (schedulingAuto) { await sendAndRecord(txt); } else { await draftForApproval(txt, null, false); }
      return ok({ ok: true, mode: action + "_ambiguous" });
    }

    const appt = appts[0];
    const oldLabel = fmtSlot(appt.starts_at, tz);

    if (action === "cancel") {
      if (schedulingAuto) {
        const c = await callDonnaCancel(appt.id);
        if (c?.ok) { await sendAndRecord(cancelText(c.when_label || oldLabel)); await ownerHeadsUp(`Donna cancelled ${convo.customer_identifier}'s appointment on ${c.when_label || oldLabel}.`); return ok({ ok: true, mode: "cancelled_auto" }); }
        await sendAndRecord(`I ran into a problem cancelling that. The team will follow up shortly.\n\nBest,\n${business}`); return ok({ ok: false, mode: "cancel_failed" });
      }
      await draftForApproval(cancelText(oldLabel), { type: "cancel", appointment_id: appt.id }, false);
      return ok({ ok: true, mode: "cancel_pending" });
    }

    if (chosenDate && chosenTime) {
      const rMode = bookMode;
      const rLoc = bookLocation;
      if (rMode === "in_person" && !rLoc) {
        const askLoc = `Happy to switch that to an on-site visit at the new time. What's the address you'd like us to come to?\n\nBest,\n${business}`;
        if (schedulingAuto) { await sendAndRecord(askLoc); } else { await draftForApproval(askLoc, null, false); }
        return ok({ ok: true, mode: "reschedule_need_location" });
      }
      const fmtNote = rMode === "virtual" ? " as a video meeting" : (rMode === "in_person" ? " as an on-site visit" : "");
      if (schedulingAuto) {
        const rr = await callDonnaReschedule(appt.id, chosenDate, chosenTime, rMode, rLoc);
        if (rr?.ok) {
          const conf = `All set, I've moved your appointment from ${rr.old_label || oldLabel} to ${rr.when_label}${rMode ? fmtNote : ""}.${rMode === "in_person" && rLoc ? ` We'll come to ${rLoc}.` : ""} If you need to change anything else, just reply.\n\nBest,\n${business}`;
          await sendAndRecord(conf);
          await ownerHeadsUp(`Donna moved ${convo.customer_identifier}'s appointment to ${rr.when_label}${rMode ? fmtNote : ""}.`);
          return ok({ ok: true, mode: "rescheduled_auto" });
        }
        const slots = await gatherSlots(convo.account_id, tz, dur);
        await sendAndRecord(slots.length ? await writeProposal(slots, true) : askForTimeText());
        return ok({ ok: true, mode: "reschedule_taken_auto" });
      }
      await draftForApproval(rescheduleText(oldLabel, `${chosenDate} at ${chosenTime}`) + (rMode ? `\n\n(Format: ${fmtNote.trim()}${rMode === "in_person" && rLoc ? " at " + rLoc : ""})` : ""), { type: "reschedule", appointment_id: appt.id, date: chosenDate, time: chosenTime, mode: rMode, location: rLoc }, false);
      return ok({ ok: true, mode: "reschedule_pending" });
    }

    const slots = await gatherSlots(convo.account_id, tz, dur);
    const bodyText = slots.length ? await writeProposal(slots, false) : askForTimeText();
    if (schedulingAuto) { await sendAndRecord(bodyText); return ok({ ok: true, mode: "reschedule_proposed_auto" }); }
    await draftForApproval(bodyText, null, false);
    return ok({ ok: true, mode: "reschedule_proposed_pending" });
  }

  // ---- New booking ----
  if (schedulingEnabled && parsed.needs_scheduling && !escalate) {
    // Salon team: book a SPECIFIC provider (resolve who, check their hours, book them).
    if (salonTeam && bookablePeople.length) {
      const { match, ambiguous } = matchStylist(bookablePeople, String(parsed.stylist || ""));
      if (!match) {
        const askWho = ambiguous
          ? `Happy to book that. Could you give me their last name so I get the right ${providerWord}?`
          : `Happy to help you book. Which ${providerWord} would you like to see? We have ${listNames(bookablePeople)}.`;
        const askBody = `Hi there,\n\n${askWho}\n\nBest,\n${business}`;
        if (schedulingAuto) { await sendAndRecord(askBody); } else { await draftForApproval(askBody, null, false); }
        return ok({ ok: true, mode: "salon_need_provider" });
      }
      const target = match;
      const who = firstNameOf(target.full_name) || providerWord;
      let typeRow: any = null;
      const svc = String(parsed.service || "").trim().toLowerCase();
      if (svc) typeRow = activeTypes.find((t) => String(t.name || "").toLowerCase() === svc) || activeTypes.find((t) => String(t.name || "").toLowerCase().includes(svc) || svc.includes(String(t.name || "").toLowerCase()));
      if (!typeRow && bookMode) typeRow = activeTypes.find((t) => t.mode === bookMode);
      if (!typeRow && activeTypes.length) typeRow = activeTypes[0];
      const sDur = typeRow?.default_duration_min || dur;
      const sTypeId = typeRow?.id || null;
      const sMode = typeRow?.mode || bookMode || "in_person";
      const cDate = String(parsed.chosen_date || "").trim();
      const cTime = String(parsed.chosen_time || "").trim();

      if (cDate && cTime) {
        const { data: inst } = await supabase.rpc("donna_slot_instant", { p_date: cDate, p_time: cTime, p_tz: tz });
        const startIso = inst ? new Date(inst as string).toISOString() : null;
        let isOpen = false;
        if (startIso) { const { data: o } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: convo.account_id, p_user_id: target.id, p_start: startIso, p_dur_min: sDur, p_tz: tz }); isOpen = o === true; }
        if (startIso && isOpen) {
          if (schedulingAuto) {
            const r = await callStaffBook(target.id, startIso, sTypeId, sDur, sMode);
            if (r?.ok) { await sendAndRecord(confirmText(r.when_label || fmtSlot(startIso, tz))); await ownerHeadsUp(`Donna booked ${convo.customer_identifier} with ${target.full_name} for ${r.when_label || fmtSlot(startIso, tz)}.`, "stylist"); return ok({ ok: true, mode: "salon_booked_auto" }); }
            const slots = await gatherSlotsForUser(convo.account_id, target.id, tz, sDur);
            await sendAndRecord(slots.length ? await writeProposal(slots, true) : askForTimeText());
            return ok({ ok: true, mode: "salon_taken_auto" });
          }
          await draftForApproval(confirmText(fmtSlot(startIso, tz)), { type: "staffbook", user_id: target.id, start_iso: startIso, type_id: sTypeId, dur_min: sDur, mode: sMode, tz }, false);
          return ok({ ok: true, mode: "salon_pending" });
        }
        const slots = await gatherSlotsForUser(convo.account_id, target.id, tz, sDur);
        const body = slots.length ? await writeProposal(slots, true) : askForTimeText();
        if (schedulingAuto) { await sendAndRecord(body); } else { await draftForApproval(body, null, false); }
        return ok({ ok: true, mode: "salon_taken" });
      }

      const slots = await gatherSlotsForUser(convo.account_id, target.id, tz, sDur);
      const body = slots.length
        ? `Hi there,\n\nHappy to book you with ${who}. Here are some times ${who} has open:\n\n${slots.map((s) => `- ${s.label}`).join("\n")}\n\nReply with whichever works and I'll lock it in.\n\nBest,\n${business}`
        : askForTimeText();
      if (schedulingAuto) { await sendAndRecord(body); } else { await draftForApproval(body, null, false); }
      return ok({ ok: true, mode: "salon_proposed" });
    }

    const chosenDate = String(parsed.chosen_date || "").trim();
    const chosenTime = String(parsed.chosen_time || "").trim();

    if (chosenDate && chosenTime) {
      if (schedulingAuto) {
        const book = await callDonnaBook({ date: chosenDate, time: chosenTime });
        if (book?.ok) {
          await sendAndRecord(confirmText(book.when_label || fmtSlot(chosenDate + "T" + chosenTime, tz)));
          await ownerHeadsUp(`Donna booked ${convo.customer_name || convo.customer_identifier} (${convo.customer_identifier}) for ${book.when_label || (chosenDate + " " + chosenTime)}.`);
          return ok({ ok: true, mode: "scheduled_auto", when_label: book.when_label });
        }
        const slots = await gatherSlots(convo.account_id, tz, dur);
        await sendAndRecord(slots.length ? await writeProposal(slots, true) : askForTimeText());
        return ok({ ok: true, mode: "scheduled_taken_auto" });
      } else {
        const { data: instant } = await supabase.rpc("donna_slot_instant", { p_date: chosenDate, p_time: chosenTime, p_tz: tz });
        let open = true;
        if (instant) {
          const { data: o } = await supabase.rpc("donna_is_slot_open", { p_account_id: convo.account_id, p_start: new Date(instant as string).toISOString(), p_dur_min: dur, p_tz: tz });
          open = o !== false;
        }
        if (open) {
          const label = instant ? fmtSlot(new Date(instant as string).toISOString(), tz) : `${chosenDate} at ${chosenTime}`;
          await draftForApproval(confirmText(label), { type: "book", date: chosenDate, time: chosenTime, tz, caller: convo.customer_name || "", email: convo.customer_identifier, conversation_id: conversationId, mode: bookMode, appointment_type_id: bookTypeId, location: bookLocation }, false);
          return ok({ ok: true, mode: "scheduled_pending_approval" });
        }
        const slots = await gatherSlots(convo.account_id, tz, dur);
        await draftForApproval(slots.length ? await writeProposal(slots, true) : askForTimeText(), null, false);
        return ok({ ok: true, mode: "scheduled_taken_pending" });
      }
    }

    const slots = await gatherSlots(convo.account_id, tz, dur);
    const bodyText = slots.length ? await writeProposal(slots, false) : askForTimeText();
    if (schedulingAuto) { await sendAndRecord(bodyText); return ok({ ok: true, mode: "proposed_auto", options: slots.length }); }
    await draftForApproval(bodyText, null, false);
    return ok({ ok: true, mode: "proposed_pending", options: slots.length });
  }

  if (autoSend && !escalate) {
    await sendAndRecord(reply);
    return ok({ ok: true, mode: "auto_sent" });
  }
  await draftForApproval(reply, null, escalate);
  return ok({ ok: true, mode: escalate ? "escalated_draft" : "draft" });
});
