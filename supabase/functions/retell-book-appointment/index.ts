import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna book appointment (Retell).
//  - SALON TEAM accounts: stylist-aware. Resolves which bookable person the caller asked
//    for, resolves the service, verifies the slot is open for THAT stylist, then delegates
//    to staff-book (service role) so it runs through the same path as a dashboard booking.
//  - Every other business that is not property management (v27): the same provider path, with the
//    owner (or the bookable people) as the provider. Service matched by name (right duration and title),
//    the service address captured for jobs at the customer's place, text confirmation when SMS is on.
//  - Property management keeps the original account-level path (its visits carry a property).
//  - v28: a booking always carries a name; without one (and no known contact on the number) the tool asks for it.
//  - v31: real drive time via drive-time when a Google Maps key is on file.
//  - v32: card on file at booking for contractors (settings.contractor.card_on_file_types / card_on_file_all) via payments.card_setup_send.
//  - v30: contractor dispatch. Only techs whose trades include the service's category and whose service_zips
//    include the job's zip are considered; the caller never picks a tech, Donna assigns the first one open.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const DASHBOARD_URL = "https://donna-dashboard-three.vercel.app";
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
  if (!valid && RETELL_SIG_ENFORCE) return { reject: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  return { reject: null };
}

function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }
function msCal(calId: string): string { const c = String(calId || "").trim(); const lc = c.toLowerCase(); return (!c || lc === "primary" || lc === "default") ? "me" : `me/calendars/${encodeURIComponent(c)}`; }
function firstName(n: string): string { return String(n || "").trim().split(/\s+/)[0] || ""; }
function matchStylist(people: any[], raw: string): { match: any | null; ambiguous: boolean } {
  const q = String(raw || "").trim().toLowerCase().replace(/^(with|by)\s+/, "");
  if (!q) return { match: null, ambiguous: false };
  const exact = people.filter((p) => String(p.full_name || "").trim().toLowerCase() === q || firstName(p.full_name).toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], ambiguous: false };
  if (exact.length > 1) return { match: null, ambiguous: true };
  const starts = people.filter((p) => { const fn = firstName(p.full_name).toLowerCase(); return String(p.full_name || "").trim().toLowerCase().startsWith(q) || (fn && q.startsWith(fn)); });
  if (starts.length === 1) return { match: starts[0], ambiguous: false };
  if (starts.length > 1) return { match: null, ambiguous: true };
  // tolerate a mis-heard short name ("Anne" for "An", "May" for "Mai")
  const loose = people.filter((p) => { const fn = firstName(p.full_name).toLowerCase(); return fn.length >= 2 && (q.startsWith(fn.slice(0, 2)) && Math.abs(q.length - fn.length) <= 2); });
  if (loose.length === 1) return { match: loose[0], ambiguous: false };
  return { match: null, ambiguous: false };
}
function listNames(people: any[]): string {
  const names = people.map((p) => firstName(p.full_name) || p.full_name).filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}
function resolveMode(raw: string): string | null {
  const t = String(raw || "").trim().toLowerCase(); if (!t) return null;
  if (/video|virtual|zoom|meet|teams|online/.test(t)) return "virtual";
  if (/site|in.?person|person|visit|onsite|salon|shop|chair/.test(t)) return "in_person";
  if (/phone|call/.test(t)) return "phone";
  return null;
}
// Contractor dispatch: who may take this service in this zip. Empty lists on a tech mean "anything / anywhere".
const zipOf = (s: string) => (String(s || "").match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || "";
// v31: real drive time (drive-time.check) when a Google Maps key is on file; otherwise the flat buffer already in SQL rules.
async function canDrive(accountId: string, userId: string, startIso: string, durMin: number, address: string): Promise<boolean> {
  if (!address) return true;
  try {
    const r = await fetch(`${SELF}/drive-time`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "check", account_id: accountId, user_id: userId, start_iso: startIso, dur_min: durMin, address }) });
    const j: any = await r.json().catch(() => ({}));
    return j?.ok ? j.fits !== false : true;
  } catch { return true; }
}
function eligibleTechs(people: any[], trade: string, zip: string): { list: any[]; reason: "trade" | "zip" | null } {
  const t = String(trade || "").trim().toLowerCase();
  const byTrade = people.filter((p) => !t || !Array.isArray(p.trades) || !p.trades.length || p.trades.some((x: string) => String(x).toLowerCase() === t));
  if (!byTrade.length) return { list: [], reason: "trade" };
  const byZip = byTrade.filter((p) => !zip || !Array.isArray(p.service_zips) || !p.service_zips.length || p.service_zips.map(String).includes(zip));
  if (!byZip.length) return { list: [], reason: "zip" };
  return { list: byZip, reason: null };
}

// ---- legacy calendar helpers (account-level path, unchanged behavior) ----
type Conn = { provider: string; access_token: string | null; refresh_token: string | null; token_expires_at: string | null; calendar_id: string | null; status: string; external_account: string | null; };
async function getConnection(accountId: string): Promise<Conn | null> {
  const { data } = await supabase.from("calendar_connections").select("provider, access_token, refresh_token, token_expires_at, calendar_id, status, external_account").eq("account_id", accountId).eq("status", "connected").order("is_active", { ascending: false }).order("updated_at", { ascending: false }).limit(1);
  const conn = data?.[0] as Conn | undefined;
  if (!conn || !conn.refresh_token) return null;
  return conn;
}
const SECRET_KEYS: Record<string, [string, string]> = { google: ["google_client_id", "google_client_secret"], microsoft: ["microsoft_client_id", "microsoft_client_secret"] };
async function getAccess(accountId: string, conn: Conn): Promise<{ token: string; calendarId: string; provider: string } | null> {
  const provider = conn.provider;
  const calendarId = conn.calendar_id || "primary";
  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token && expMs - Date.now() > 120000) return { token: conn.access_token, calendarId, provider };
  const keys = SECRET_KEYS[provider]; if (!keys) return null;
  const { data: secrets } = await supabase.from("app_secrets").select("key,value").in("key", keys);
  const map: Record<string, string> = Object.fromEntries((secrets ?? []).map((r: any) => [r.key, r.value]));
  const cid = map[keys[0]], csec = map[keys[1]]; if (!cid || !csec) return null;
  const res = provider === "google"
    ? await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token" }) })
    : await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token", scope: "offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read https://graph.microsoft.com/OnlineMeetings.ReadWrite" }) });
  const tok: any = await res.json();
  if (!res.ok || !tok.access_token) return null;
  const newExp = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const upd: Record<string, unknown> = { access_token: tok.access_token, token_expires_at: newExp, updated_at: new Date().toISOString() };
  if (tok.refresh_token) upd.refresh_token = tok.refresh_token;
  await supabase.from("calendar_connections").update(upd).eq("account_id", accountId).eq("provider", provider).eq("status", "connected");
  return { token: tok.access_token, calendarId, provider };
}
function graphTimeToISO(dt: any): string { if (!dt?.dateTime) return new Date().toISOString(); let s: string = dt.dateTime; if (!s.endsWith("Z")) s = s.replace(/(\.\d+)?$/, "") + "Z"; return new Date(s).toISOString(); }
async function busyIntervals(accountId: string, timeMin: string, timeMax: string): Promise<{ start: string; end: string }[] | null> {
  const conn = await getConnection(accountId); if (!conn) return null;
  const acc = await getAccess(accountId, conn); if (!acc) return null;
  if (acc.provider === "google") {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { "Authorization": `Bearer ${acc.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ timeMin, timeMax, items: [{ id: acc.calendarId }] }) });
    if (!res.ok) return null;
    const data: any = await res.json();
    return (data?.calendars?.[acc.calendarId]?.busy ?? []) as { start: string; end: string }[];
  }
  const url = `https://graph.microsoft.com/v1.0/${msCal(acc.calendarId)}/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$select=start,end,showAs,isCancelled&$top=100`;
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${acc.token}`, "Prefer": 'outlook.timezone="UTC"' } });
  if (!res.ok) return null;
  const data: any = await res.json();
  return (data?.value ?? []).filter((e: any) => !e.isCancelled && e.showAs !== "free").map((e: any) => ({ start: graphTimeToISO(e.start), end: graphTimeToISO(e.end) }));
}
async function getSettings(accountId: string): Promise<any> { const { data } = await supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle(); return (data as any)?.settings || {}; }
async function ownerHeadsUp(settings: any, text: string) {
  if (!RESEND_KEY) return;
  const messagingEnabled = settings?.messaging_enabled === true;
  const to = ((messagingEnabled && String(settings?.escalation_email || "").trim()) || String(settings?.alert_email || "").trim());
  if (!to) return;
  const from = String(settings?.email_reply_from || "Donna <no-reply@client.sidekicklogistics.com>").trim();
  try { await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject: "Donna booked an appointment", text }) }); } catch (_e) { /* */ }
}
async function mintVideo(accountId: string, start: string, end: string, subject: string): Promise<string | null> {
  try { const r = await fetch(`${SELF}/donna-video`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "mint", account_id: accountId, start_iso: new Date(start).toISOString(), end_iso: new Date(end).toISOString(), subject }) }); const j: any = await r.json(); return j && j.ok ? j.url : null; } catch (_e) { return null; }
}
async function createEvent(accountId: string, appt: any, tz: string, attendeeEmail: string): Promise<{ ok: boolean; id: string | null; provider: string | null; meetingUrl: string | null }> {
  const conn = await getConnection(accountId); if (!conn) return { ok: false, id: null, provider: null, meetingUrl: null };
  const acc = await getAccess(accountId, conn); if (!acc) return { ok: false, id: null, provider: null, meetingUrl: null };
  const s = await getSettings(accountId);
  const inviteCustomer = s.calendar_invite_customer === true;
  const addAttendee = !!attendeeEmail && inviteCustomer;
  const virtual = appt.mode === "virtual";
  const onsite = appt.mode === "in_person" && appt.location_address;
  let pastedUrl: string | null = null; let useNative = false;
  if (virtual) {
    const vp = s.video_provider;
    const sameAccount = vp && vp.provider === conn.provider && String(vp.external_account || "") === String(conn.external_account || "");
    if (vp && !sameAccount) { pastedUrl = await mintVideo(accountId, appt.starts_at, appt.ends_at, appt.title || "Appointment"); if (!pastedUrl) useNative = true; } else useNative = true;
  }
  if (acc.provider === "google") {
    const desc = [appt.notes || "Booked by Donna."]; if (pastedUrl) desc.push("Video meeting: " + pastedUrl);
    const event: any = { summary: appt.title || "Appointment", description: desc.join("\n"), start: { dateTime: new Date(appt.starts_at).toISOString(), timeZone: tz }, end: { dateTime: new Date(appt.ends_at).toISOString(), timeZone: tz } };
    if (addAttendee) event.attendees = [{ email: attendeeEmail }];
    if (onsite) event.location = appt.location_address; else if (pastedUrl) event.location = pastedUrl;
    const params: string[] = []; if (addAttendee) params.push("sendUpdates=all");
    if (virtual && useNative) { event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } }; params.push("conferenceDataVersion=1"); }
    const qs = params.length ? "?" + params.join("&") : "";
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(acc.calendarId)}/events${qs}`, { method: "POST", headers: { "Authorization": `Bearer ${acc.token}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    const ev: any = await res.json();
    if (!res.ok) { console.error("google create", res.status, JSON.stringify(ev).slice(0, 200)); return { ok: false, id: null, provider: "google", meetingUrl: null }; }
    const nativeLink = ev.hangoutLink || (ev.conferenceData?.entryPoints ?? []).find((e: any) => e.entryPointType === "video")?.uri || null;
    return { ok: true, id: ev.id ?? null, provider: "google", meetingUrl: pastedUrl || nativeLink };
  }
  const bodyParts = [appt.notes || "Booked by Donna."]; if (pastedUrl) bodyParts.push("Video meeting: " + pastedUrl);
  const event: any = { subject: appt.title || "Appointment", body: { contentType: "text", content: bodyParts.join("\n") }, start: { dateTime: new Date(appt.starts_at).toISOString().replace("Z", ""), timeZone: "UTC" }, end: { dateTime: new Date(appt.ends_at).toISOString().replace("Z", ""), timeZone: "UTC" } };
  if (addAttendee) event.attendees = [{ emailAddress: { address: attendeeEmail }, type: "required" }];
  if (onsite) event.location = { displayName: appt.location_address }; else if (pastedUrl) event.location = { displayName: pastedUrl };
  if (virtual && useNative) { event.isOnlineMeeting = true; event.onlineMeetingProvider = "teamsForBusiness"; }
  const res = await fetch(`https://graph.microsoft.com/v1.0/${msCal(acc.calendarId)}/events`, { method: "POST", headers: { "Authorization": `Bearer ${acc.token}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
  const ev: any = await res.json();
  if (!res.ok) { console.error("ms create", res.status, JSON.stringify(ev).slice(0, 200)); return { ok: false, id: null, provider: "microsoft", meetingUrl: null }; }
  const nativeLink = ev.onlineMeeting?.joinUrl || null;
  return { ok: true, id: ev.id ?? null, provider: "microsoft", meetingUrl: pastedUrl || nativeLink };
}
async function syncLatestAppointment(accountId: string, tz: string, attendeeEmail: string): Promise<string | null> {
  const { data: appt } = await supabase.from("appointments").select("id, title, starts_at, ends_at, notes, mode, location_address").eq("account_id", accountId).eq("sync_status", "pending").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!appt) return null;
  if (attendeeEmail) await supabase.from("appointments").update({ customer_email: attendeeEmail }).eq("id", appt.id);
  const result = await createEvent(accountId, appt, tz, attendeeEmail);
  if (!result.ok) { await supabase.from("appointments").update({ sync_status: "failed" }).eq("id", appt.id); return appt.id; }
  await supabase.from("appointments").update({ external_event_id: result.id, external_provider: result.provider, sync_status: "synced", synced_at: new Date().toISOString(), meeting_url: result.meetingUrl }).eq("id", appt.id);
  return appt.id;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ result: "" }, 405);
  const _gate = await retellGate(req, "book-appointment");
  if (_gate.reject) return _gate.reject;
  let body: any = {};
  try { body = await req.json(); } catch { return json({ result: "Sorry, I couldn't book that just now." }); }

  const call = body?.call ?? {}; const args = body?.args ?? {};
  const toNumber = call?.to_number; const fromNumber = call?.from_number ?? ""; const retellId = call?.call_id ?? null;

  const caller = String(args?.caller_name ?? "").trim();
  const phone = (String(args?.phone ?? "").trim() || fromNumber || "");
  const email = String(args?.email ?? "").trim();
  const date = String(args?.date ?? "").trim();
  const time = String(args?.time ?? "").trim();
  const notes = String(args?.notes ?? "").trim();
  const language = String(args?.language ?? "").trim() || null;
  const stylistArg = String(args?.stylist ?? "").trim();
  const serviceArg = String(args?.service ?? "").trim();
  const mode = resolveMode(String(args?.appointment_type ?? args?.mode ?? serviceArg ?? ""));
  const location = String(args?.location ?? "").trim() || null;

  if (!toNumber || !date || !time) return json({ result: "I just need a day and time to book it, what works for you?" });
  // Every booking needs a name on it. If the caller is already known by this number, that name is used.
  if (!caller) {
    const { data: a0 } = await supabase.from("assistants").select("account_id").eq("twilio_number", toNumber).maybeSingle();
    let known = "";
    if (a0?.account_id && phone) { const { data: c0 } = await supabase.from("contacts").select("name").eq("account_id", a0.account_id).eq("phone", phone).order("updated_at", { ascending: false }).limit(1); known = String((c0 && c0[0]?.name) || "").trim(); }
    if (!known) return json({ result: "And who should I put this under?", need: "caller_name" });
    args.caller_name = known;
  }
  const callerName = caller || String(args?.caller_name || "").trim();

  const { data: asst } = await supabase.from("assistants").select("account_id, accounts(settings, plan, industry)").eq("twilio_number", toNumber).maybeSingle();
  if (!asst) return json({ result: "Sorry, I couldn't book that just now." });
  const settings: any = (asst.accounts as any)?.settings || {};
  const tz = settings.timezone || "America/Chicago";
  const feats = settings.features || {};
  const isContractor = String(settings?.industry || (asst.accounts as any)?.industry || "") === "contractor";

  // ===== SALON TEAM: stylist-aware booking via staff-book =====
  const isSalon = feats.salon === true;
  const smsOn = settings?.sms?.enabled === true && settings?.sms?.confirmations !== false;
  const anyone = (s: string) => /^(any|anyone|anybody|whoever|whoever'?s? (available|free|open)|no preference|either|first available|doesn'?t matter|don'?t care)$/i.test(String(s || "").trim());

  const providerPath = isSalon || feats.property_management !== true;
  if (providerPath) {
    const { data: bookable } = await supabase.from("users").select("id, full_name, role, trades, service_zips").eq("account_id", asst.account_id).eq("is_bookable", true).eq("is_active", true).order("created_at");
    let people = (bookable || []) as any[];
    if (!people.length) {
      // solo shop with nobody flagged bookable: the owner is the stylist and the dashboard hours are theirs
      const { data: owner } = await supabase.from("users").select("id, full_name, role, trades, service_zips").eq("account_id", asst.account_id).eq("role", "owner").order("created_at").limit(1);
      people = (owner || []) as any[];
    }
    if (people.length) {
      const { data: typeList } = await supabase.from("appointment_types").select("id, name, default_duration_min, mode, overlap_minutes, requires_travel, category").eq("account_id", asst.account_id).eq("is_active", true).order("created_at");
      const types = (typeList || []) as any[];
      const matchOne = (q0: string) => { const q = q0.toLowerCase().trim(); if (!q) return null; return types.find((t) => String(t.name || "").toLowerCase() === q) || types.find((t) => String(t.name || "").toLowerCase().includes(q) || q.includes(String(t.name || "").toLowerCase())) || types.find((t) => q.split(/\s+/).some((w) => w.length > 3 && String(t.name || "").toLowerCase().includes(w))) || null; };
      let legs: any[] = [];
      for (const part of serviceArg.split(/\s*(?:\+|,|&|\band\b|\bwith\b|\bplus\b)\s*/i)) { const m = matchOne(part); if (m && !legs.includes(m)) legs.push(m); }
      if (!legs.length && serviceArg) { const m = matchOne(serviceArg); if (m) legs = [m]; }
      if (!legs.length && types.length > 1 && !serviceArg) return json({ result: `Sure. What are we booking you for? We offer ${types.map((t) => t.name).join(", ")}.` });
      if (!legs.length && types.length) legs = [types[0]];
      const typeRow: any = legs[0] || null;
      const typeId = typeRow?.id || null;
      const dur = legs.reduce((n, t) => n + (Number(t.default_duration_min) || 45), 0) || 45;
      const comboName = legs.map((t) => t.name).join(" + ");
      const bmode = isSalon ? "in_person" : (mode || typeRow?.mode || "in_person");
      // Jobs at the customer's place (mobile detailer, cleaner, contractor): we need the address before booking.
      const atCustomer = !isSalon && (isContractor || legs.some((t) => t.requires_travel === true));
      if (atCustomer && !location) return json({ result: `What's the address where you'd like us to come${typeRow ? " for the " + typeRow.name.toLowerCase() : ""}?`, need: "location" });

      // Contractors: only techs who do this trade and cover this zip are in the running.
      if (isContractor) {
        const e = eligibleTechs(people, String(typeRow?.category || ""), zipOf(location || ""));
        if (!e.list.length) {
          if (e.reason === "zip") return json({ result: `I'm sorry, we don't currently service the ${zipOf(location || "")} area. Would you like me to take your details in case that changes?`, out_of_area: true });
          return json({ result: `We don't have anyone who handles ${comboName || "that"} right now. Let me take your details and have the office call you back.`, no_trade: true });
        }
        people = e.list;
      }

      const { data: inst } = await supabase.rpc("donna_slot_instant", { p_date: date, p_time: time, p_tz: tz });
      if (!inst) return json({ result: "What day and time were you thinking? I'll get it set." });
      const startIso = new Date(inst as string).toISOString();
      if (new Date(startIso).getTime() <= Date.now()) return json({ result: "That time has already passed. What day and time would you like?" });

      let target: any = null;
      if (stylistArg && !anyone(stylistArg) && !isContractor) {
        const { match, ambiguous } = matchStylist(people, stylistArg);
        if (ambiguous) return json({ result: `We have more than one ${stylistArg}. Could you give me their last name?` });
        if (!match) return json({ result: `I don't have anyone by that name. We have ${listNames(people)}. Who would you like?` });
        target = match;
      } else if (people.length === 1) {
        target = people[0];
      } else {
        // "whoever's available": the first person open at that time, owner first (contractors: and who can drive there in time)
        for (const p of people) {
          const { data: ok } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: asst.account_id, p_user_id: p.id, p_start: startIso, p_dur_min: dur, p_tz: tz });
          if (ok && (!isContractor || await canDrive(asst.account_id, p.id, startIso, dur, location || ""))) { target = p; break; }
        }
        if (!target) return json({ result: `No one's open at that time${typeRow ? " for a " + typeRow.name.toLowerCase() : ""}. Want me to check what else is open that day?` });
      }

      const who = firstName(target.full_name) || "they";
      let { data: isOpen } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: asst.account_id, p_user_id: target.id, p_start: startIso, p_dur_min: dur, p_tz: tz });
      if (isOpen && isContractor && people.length === 1 && !(await canDrive(asst.account_id, target.id, startIso, dur, location || ""))) isOpen = false;
      if (!isOpen) return json({ result: ((!isSalon && people.length === 1) || isContractor) ? `That time isn't open${typeRow ? " for a " + typeRow.name.toLowerCase() : ""}. Want me to check what else is open that day?` : `${who} isn't open at that time${typeRow ? " for a " + typeRow.name.toLowerCase() : ""}. Want me to check what else ${who} has that day${people.length > 1 ? ", or see someone else" : ""}?` });

      // Book each leg back to back with the same stylist; one confirmation goes out (from the last leg, which describes the whole visit).
      let r: any = null;
      const comboGroup = legs.length > 1 ? crypto.randomUUID() : null;
      let cursor = startIso; const bookedIds: string[] = [];
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]; const legDur = Number(leg.default_duration_min) || 45;
        let lr: any = null;
        try {
          const resp = await fetch(`${SELF}/staff-book`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` },
            body: JSON.stringify({ action: "book", account_id: asst.account_id, user_id: target.id, tz, start_iso: cursor, type_id: leg.id, dur_min: legDur, mode: bmode, location: bmode === "in_person" ? location : null, client_name: callerName, client_phone: phone, customer_email: email, notes, source: "phone", combo_group: comboGroup, skip_notify: legs.length > 1 && i < legs.length - 1 }) });
          lr = await resp.json();
        } catch (_e) { lr = null; }
        if (!lr || !lr.ok) {
          // undo earlier legs so a half-booked combo never lingers
          for (const id of bookedIds) { try { await supabase.from("appointments").update({ status: "cancelled" }).eq("id", id); } catch (_e) { /* */ } }
          if (lr && (lr.error === "conflict" || lr.error === "blocked" || lr.error === "unavailable")) return json({ result: `It looks like that time just filled up${isContractor ? "" : " for " + who}${legs.length > 1 ? " for the full " + comboName : ""}. Want me to check what else is open that day?` });
          return json({ result: "Sorry, I ran into a problem booking that. Let me take a message instead." });
        }
        bookedIds.push(lr.id); r = r || lr; r = { ...lr, id: r.id || lr.id, when_label: r.when_label || lr.when_label, texted: r.texted || lr.texted, emailed: r.emailed || lr.emailed, contact_id: lr.contact_id || r.contact_id };
        cursor = lr.ends_at || new Date(new Date(cursor).getTime() + legDur * 60000).toISOString();
      }
      // Client card: anything the caller said about allergies / sensitivities lands on the contact so every stylist sees it.
      try {
        if (isSalon && r?.contact_id && notes && /allerg|sensitiv|react|irritat|scalp|latex|fragrance|pregnan/i.test(notes)) {
          const { data: c0 } = await supabase.from("contacts").select("allergies").eq("id", r.contact_id).maybeSingle();
          const cur = String((c0 as any)?.allergies || "").trim();
          if (!cur) await supabase.from("contacts").update({ allergies: notes.slice(0, 300) }).eq("id", r.contact_id);
        }
      } catch (_e) { /* */ }
      if (language && r.id) { try { await supabase.from("appointments").update({ language }).eq("id", r.id); } catch (_e) { /* */ } }
      // Card on file at booking (contractors; per service): Donna texts a Stripe link to save a card, nothing charged until Done.
      let cardAsked = false;
      if (isContractor && r.id && phone) {
        const ctr: any = settings.contractor || {};
        const want = ctr.card_on_file_all === true || (Array.isArray(ctr.card_on_file_types) && legs.some((t) => ctr.card_on_file_types.includes(t.id)));
        if (want) { try { const cr = await fetch(`${SELF}/payments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "card_setup_send", user_id: target.id, appointment_id: r.id, phone }) }); const cj: any = await cr.json().catch(() => ({})); cardAsked = !!(cj?.ok && cj.sent); } catch (_e) { /* */ } }
      }
      if (retellId) { const { data: c } = await supabase.from("calls").select("id").eq("twilio_call_sid", retellId).maybeSingle(); if (c?.id) { const patch: Record<string, unknown> = { outcome: "booked" }; if (language) patch.language = language; await supabase.from("calls").update(patch).eq("id", c.id); } }
      try {
        const lines = [`${callerName || "A caller"}${phone ? " (" + phone + ")" : ""}`, people.length > 1 || isContractor ? `With ${target.full_name || who}` : "", String(r.when_label), comboName ? ("Service: " + comboName) : "", (bmode === "in_person" && location) ? ("Where: " + location) : (bmode === "virtual" ? "Video call" : (bmode === "phone" ? "Phone call" : ""))].filter(Boolean);
        if (email) lines.push("Customer email: " + email);
        lines.push("", "See it in your dashboard: " + DASHBOARD_URL);
        await ownerHeadsUp(settings, "Donna just booked an appointment by phone.\n\n" + lines.join("\n"));
      } catch (_e) { /* */ }
      const svcWord = comboName ? ` for ${legs.length > 1 ? comboName.toLowerCase() + " back to back" : comboName.toLowerCase()}` : "";
      let extra = "";
      if (r.texted && r.emailed) extra = " I've texted and emailed you a confirmation.";
      else if (r.texted) extra = " I've texted you a confirmation.";
      else if (r.emailed) extra = " I've emailed you a confirmation.";
      else if (smsOn && !email) extra = " You'll get a text confirmation shortly.";
      else if (email) extra = " I'll send a confirmation to your email.";
      const soloGeneral = (!isSalon && people.length === 1) || isContractor;
      const whereWord = (!isSalon && bmode === "in_person" && location) ? ` at ${location}` : "";
      if (cardAsked) extra += " I've also texted you a secure link to put a card on file; nothing is charged until the work is done.";
      return json({ result: `You're all set${soloGeneral ? "" : " with " + who}${svcWord} on ${r.when_label}${whereWord}.${extra} Anything else I can help with?`, booked: true, stylist: soloGeneral ? null : who, service: comboName || null, legs: legs.length, when: r.when_label, location: location || null });
    }
  }

  let typeId: string | null = null;
  if (mode) { const { data: t } = await supabase.from("appointment_types").select("id").eq("account_id", asst.account_id).eq("is_active", true).eq("mode", mode).order("created_at").limit(1); typeId = t?.[0]?.id ?? null; }

  try {
    const { data: types } = await supabase.from("appointment_types").select("default_duration_min").eq("account_id", asst.account_id).eq("is_active", true).order("created_at").limit(1);
    const dur = (types && types[0]?.default_duration_min) || 30;
    const { data: instant } = await supabase.rpc("donna_slot_instant", { p_date: date, p_time: time, p_tz: tz });
    if (instant) {
      const startMs = new Date(instant as string).getTime();
      const busy = await busyIntervals(asst.account_id, new Date(startMs).toISOString(), new Date(startMs + dur * 60000).toISOString());
      if (busy && busy.length) return json({ result: "It looks like that time just filled up. Want me to check what else is open that day?" });
    }
  } catch (_e) { /* */ }

  const { data, error } = await supabase.rpc("donna_book_appointment", { p_account_id: asst.account_id, p_date: date, p_time: time, p_tz: tz, p_caller: callerName, p_phone: phone, p_notes: notes || null, p_language: language, p_appointment_type_id: typeId, p_mode: mode, p_location: location });
  if (error) return json({ result: "Sorry, I ran into a problem booking that. Let me take a message instead." });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) return json({ result: `That time isn't available${row?.when_label ? ` (${row.when_label})` : ""}. Want me to check what else is open that day?` });

  if (retellId) { const { data: c } = await supabase.from("calls").select("id").eq("twilio_call_sid", retellId).maybeSingle(); if (c?.id) { const patch: Record<string, unknown> = { outcome: "booked" }; if (language) patch.language = language; await supabase.from("calls").update(patch).eq("id", c.id); } }

  let apptId: string | null = null;
  try { apptId = await syncLatestAppointment(asst.account_id, tz, email); } catch (_e) { /* */ }
  if (apptId && email) { try { await fetch(`${SELF}/donna-notify`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ appointment_id: apptId }) }); } catch (_e) { /* */ } }

  try {
    const modeLabel = mode === "virtual" ? "Video appointment" : (mode === "in_person" ? ("On-site" + (location ? " at " + location : "")) : "Phone appointment");
    const lines = [`${callerName || "A caller"}${phone ? " (" + phone + ")" : ""}`, String(row.when_label), modeLabel];
    if (email) lines.push("Customer email: " + email);
    lines.push("", "See it in your dashboard: " + DASHBOARD_URL);
    await ownerHeadsUp(settings, "Donna just booked an appointment by phone.\n\n" + lines.join("\n"));
  } catch (_e) { /* */ }

  const extra = email ? (mode === "virtual" ? " I'll email your confirmation with the video link." : " I'll send a confirmation to your email too.") : "";
  return json({ result: `You're all set for ${row.when_label}.${extra} Is there anything else I can help with?` });
});
