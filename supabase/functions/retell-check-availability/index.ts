import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — check availability (Retell custom function). Stylist- and service-aware.
//  - args.service names a service: its duration is what gets checked (a 3-hour highlights is not a 45-minute haircut).
//  - args.stylist names a person: returns THAT stylist's open times (or confirms a time).
//  - args.after / args.before / args.part_of_day narrow the window ("after 2", "mornings"), so the caller
//    hears the times they actually asked about instead of the first five of the day.
//  - no stylist on a solo account: the one bookable person; no stylist on a team: who is open.
// Open times come from each stylist's booking hours (falling back to the shop's), minus conflicts and
// time-off, then filtered against the business's connected calendar free/busy.
// v20: a one-person business that is not a salon hears "we" / "on Saturday I have…", not the owner's first name.
// v22: contractor dispatch. Techs carry trades (users.trades) and service areas (users.service_zips); the service's
//      category and the caller's zip narrow who is eligible. Contractor callers never pick a tech: eligible techs'
//      openings are merged into one list and booking assigns whoever is free.
// v23: real drive time. With a Google Maps key on file, contractor openings that don't leave enough driving time from
//      the tech's neighboring jobs to the caller's address are dropped (drive-time.filter); without a key the flat
//      travel buffer in donna_is_slot_open_user is the rule.

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
// Keep only the slots this tech can actually drive to in time. Falls back to the input on any failure.
async function driveFilter(accountId: string, userId: string, slots: string[], durMin: number, address: string): Promise<Set<string>> {
  if (!slots.length || !address) return new Set(slots);
  try {
    const r = await fetch(`${SELF}/drive-time`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "filter", account_id: accountId, user_id: userId, slots, dur_min: durMin, address }) });
    const j: any = await r.json().catch(() => ({}));
    return j?.ok && Array.isArray(j.slots) ? new Set(j.slots.map((s: string) => new Date(s).toISOString())) : new Set(slots);
  } catch { return new Set(slots); }
}

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

type Conn = { provider: string; access_token: string | null; refresh_token: string | null; token_expires_at: string | null; calendar_id: string | null; status: string; };
async function getConnection(accountId: string): Promise<Conn | null> {
  const { data } = await supabase.from("calendar_connections").select("provider, access_token, refresh_token, token_expires_at, calendar_id, status").eq("account_id", accountId).eq("status", "connected").order("updated_at", { ascending: false }).limit(1);
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
  const cid = map[keys[0]], csec = map[keys[1]];
  if (!cid || !csec) return null;
  const res = provider === "google"
    ? await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token" }) })
    : await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token", scope: "offline_access https://graph.microsoft.com/Calendars.ReadWrite" }) });
  const tok: any = await res.json();
  if (!res.ok || !tok.access_token) return null;
  const newExp = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const upd: Record<string, unknown> = { access_token: tok.access_token, token_expires_at: newExp, status: "connected", last_error: null, updated_at: new Date().toISOString() };
  if (tok.refresh_token) upd.refresh_token = tok.refresh_token;
  await supabase.from("calendar_connections").update(upd).eq("account_id", accountId).eq("provider", provider);
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

function firstName(n: string): string { return String(n || "").trim().split(/\s+/)[0] || ""; }
function matchStylist(people: any[], raw: string): { match: any | null; ambiguous: boolean } {
  const q = String(raw || "").trim().toLowerCase().replace(/^(with|by)\s+/, "");
  if (!q || /^(any|anyone|whoever|no preference|either|first available)$/.test(q)) return { match: null, ambiguous: false };
  const exact = people.filter((p) => String(p.full_name || "").trim().toLowerCase() === q || firstName(p.full_name).toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], ambiguous: false };
  if (exact.length > 1) return { match: null, ambiguous: true };
  const starts = people.filter((p) => { const fn = firstName(p.full_name).toLowerCase(); return String(p.full_name || "").trim().toLowerCase().startsWith(q) || (fn && q.startsWith(fn)); });
  if (starts.length === 1) return { match: starts[0], ambiguous: false };
  if (starts.length > 1) return { match: null, ambiguous: true };
  // tolerate a mis-heard short name ("Anne" for "An", "Mai" for "May")
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
function notBusy(slotISO: string, durMs: number, busy: { start: string; end: string }[] | null): boolean {
  if (!busy || !busy.length) return true;
  const start = new Date(slotISO).getTime(); const end = start + durMs;
  return !busy.some((b) => start < new Date(b.end).getTime() && end > new Date(b.start).getTime());
}
// "Haircut + Highlights" / "cut and color" -> every matched service, in order (combo visits are booked back to back)
function matchServices(types: any[], raw: string): any[] {
  const parts = String(raw || "").split(/\s*(?:\+|,|&|\band\b|\bwith\b|\bplus\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  const out: any[] = [];
  for (const part of parts) { const m = matchService(types, part); if (m && !out.includes(m)) out.push(m); }
  if (!out.length) { const m = matchService(types, raw); if (m) out.push(m); }
  return out;
}
function matchService(types: any[], raw: string): any | null {
  const q = String(raw || "").trim().toLowerCase(); if (!q) return null;
  return types.find((t) => String(t.name || "").toLowerCase() === q)
    || types.find((t) => String(t.name || "").toLowerCase().includes(q) || q.includes(String(t.name || "").toLowerCase()))
    || types.find((t) => q.split(/\s+/).some((w) => w.length > 3 && String(t.name || "").toLowerCase().includes(w)))
    || null;
}
// "after 2", "14:00", "2pm", "afternoon", "mornings", "before noon", "evening" -> minutes-of-day window
function parseWindow(after: string, before: string, part: string): { from: number; to: number } | null {
  const toMin = (s: string): number | null => {
    const t = String(s || "").trim().toLowerCase(); if (!t) return null;
    if (/noon/.test(t)) return 12 * 60;
    const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/); if (!m) return null;
    let h = Number(m[1]); const mi = Number(m[2] || 0); const ap = (m[3] || "").replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 6) h += 12; // "after 2" at a salon means 2 PM
    return h * 60 + mi;
  };
  let from = toMin(after) ?? 0, to = toMin(before) ?? 24 * 60;
  const p = String(part || "").toLowerCase();
  if (/morning/.test(p)) { from = Math.max(from, 0); to = Math.min(to, 12 * 60); }
  else if (/afternoon/.test(p)) { from = Math.max(from, 12 * 60); to = Math.min(to, 17 * 60); }
  else if (/evening|after work|late/.test(p)) { from = Math.max(from, 16 * 60); }
  else if (/midday|lunch/.test(p)) { from = Math.max(from, 11 * 60); to = Math.min(to, 14 * 60); }
  if (from === 0 && to === 24 * 60) return null;
  return { from, to };
}
function minutesOfDay(iso: string, tz: string): number { const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)); const g = (t: string) => Number(p.find((x) => x.type === t)?.value || 0); return (g("hour") % 24) * 60 + g("minute"); }
// pick a handful of times to say: spread across the day rather than the first five in a row
function sample(open: any[], n: number): any[] {
  if (open.length <= n) return open;
  const out: any[] = []; const step = (open.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(open[Math.round(i * step)]);
  return out;
}
// Contractor dispatch: who may take this service in this zip. Empty lists on a tech mean "anything / anywhere".
const zipOf = (s: string) => (String(s || "").match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || "";
function eligibleTechs(people: any[], trade: string, zip: string): { list: any[]; reason: "trade" | "zip" | null } {
  const t = String(trade || "").trim().toLowerCase();
  const byTrade = people.filter((p) => !t || !Array.isArray(p.trades) || !p.trades.length || p.trades.some((x: string) => String(x).toLowerCase() === t));
  if (!byTrade.length) return { list: [], reason: "trade" };
  const byZip = byTrade.filter((p) => !zip || !Array.isArray(p.service_zips) || !p.service_zips.length || p.service_zips.map(String).includes(zip));
  if (!byZip.length) return { list: [], reason: "zip" };
  return { list: byZip, reason: null };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ result: "" }, 405);
  const _gate = await retellGate(req, "check-availability");
  if (_gate.reject) return _gate.reject;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ result: "Sorry, I couldn't check the calendar just now." }); }

  const call = body?.call ?? {};
  const args = body?.args ?? {};
  const toNumber = call?.to_number;
  const date = String(args?.date ?? "").trim();
  const time = String(args?.time ?? "").trim();
  const stylistArg = String(args?.stylist ?? "").trim();
  const serviceArg = String(args?.service ?? "").trim();
  const zip = zipOf(String(args?.zip ?? "")) || zipOf(String(args?.address ?? ""));
  const driveAddr = String(args?.address ?? "").trim() || (zip ? `${zip}, USA` : "");
  const win = parseWindow(String(args?.after ?? ""), String(args?.before ?? ""), String(args?.part_of_day ?? args?.preference ?? ""));

  if (!toNumber || !date) return json({ result: "What day were you hoping to come in? I can check what's open." });

  const { data: asst } = await supabase.from("assistants").select("account_id, accounts(settings, plan, industry)").eq("twilio_number", toNumber).maybeSingle();
  if (!asst) return json({ result: "Sorry, I couldn't check the calendar just now." });
  const settings: any = (asst.accounts as any)?.settings || {};
  const tz = settings.timezone || "America/Chicago";
  const isSalon = settings?.features?.salon === true;
  const isContractor = String(settings?.industry || (asst.accounts as any)?.industry || "") === "contractor";
  const providerLabel = String(settings.provider_label || (isSalon ? "stylist" : "team member"));

  const { data: typeList } = await supabase.from("appointment_types").select("id, name, default_duration_min, overlap_minutes, category").eq("account_id", asst.account_id).eq("is_active", true).order("created_at");
  const types = (typeList || []) as any[];
  const svcs = matchServices(types, serviceArg);
  const svc = svcs[0] || null;
  const dur = svcs.length ? svcs.reduce((n, t) => n + (Number(t.default_duration_min) || 30), 0) : ((types[0]?.default_duration_min) || 30);
  const durMs = dur * 60000;
  const svcName = svcs.map((t) => t.name).join(" + ");
  const fmtDur = (m: number) => m >= 60 ? (m % 60 ? (Math.round(m / 60 * 4) / 4).toString().replace(/\.0$/, "") + " hours" : (m / 60) + (m === 60 ? " hour" : " hours")) : m + " minutes";
  const svcNote = svcs.length ? ` (${svcName}, about ${fmtDur(dur)}${svcs.length > 1 ? " total, back to back" : ""})` : "";

  const { data: bookable } = await supabase.from("users").select("id, full_name, trades, service_zips").eq("account_id", asst.account_id).eq("is_bookable", true).eq("is_active", true).order("created_at");
  let people = (bookable || []) as any[];
  if (!people.length) {
    // solo shop with nobody flagged bookable: the owner IS the stylist and the dashboard hours are theirs
    const { data: owner } = await supabase.from("users").select("id, full_name, trades, service_zips").eq("account_id", asst.account_id).eq("role", "owner").order("created_at").limit(1);
    people = (owner || []) as any[];
  }
  // Contractors: narrow to techs who do this trade and cover this zip.
  if (isContractor && people.length) {
    const trade = String(svc?.category || "");
    const e = eligibleTechs(people, trade, zip);
    if (!e.list.length) {
      if (e.reason === "zip") return json({ result: `I'm sorry, we don't currently service the ${zip} area. Would you like me to take your details in case that changes, or can I help with anything else?`, out_of_area: true, zip });
      return json({ result: `We don't have anyone who handles ${svcName || "that"} right now. Let me take your details and have the office call you back.`, no_trade: true });
    }
    people = e.list;
  }

  const fmtTime = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
  const inWin = (iso: string) => { if (!win) return true; const m = minutesOfDay(iso, tz); return m >= win.from && m < win.to; };
  const clock = (m: number) => { const h = Math.floor(m / 60), mi = m % 60; const ap = h >= 12 ? "PM" : "AM"; const hh = ((h + 11) % 12) + 1; return `${hh}${mi ? ":" + String(mi).padStart(2, "0") : ""} ${ap}`; };
  const partWord = (String(args?.part_of_day ?? args?.preference ?? "").toLowerCase().match(/morning|afternoon|evening|midday|lunch/) || [""])[0];
  const winTxt = win ? (partWord && !String(args?.after ?? "").trim() && !String(args?.before ?? "").trim() ? ` in the ${partWord === "lunch" ? "midday" : partWord}` : (win.to >= 24 * 60 ? ` after ${clock(win.from)}` : (win.from === 0 ? ` before ${win.to === 720 ? "noon" : clock(win.to)}` : ` between ${clock(win.from)} and ${clock(win.to)}`))) : "";
  const say = (slots: any[], n = 5) => sample(slots, n).map((s: any) => fmtTime.format(new Date(s.slot))).join(", ");
  const meta = { duration_min: dur, service: svcs.length ? svcName : null, services: svcs.map((t) => t.name), note: svcs.length > 1 ? "Book with 24-hour time, e.g. 14:00, passing the same combined service so both are booked back to back." : "Book with 24-hour time, e.g. 14:00." };

  let target: any = null;
  if (stylistArg && !isContractor) {
    const { match, ambiguous } = matchStylist(people, stylistArg);
    if (ambiguous) return json({ result: `We have more than one ${stylistArg}. Could you give me their last name too?`, ...meta });
    if (!match && !/^(any|anyone|whoever|no preference|either|first available)$/i.test(stylistArg)) {
      if (!people.length) return json({ result: "Let me take your details and have someone call you back to set that up.", ...meta });
      return json({ result: `I don't have a ${providerLabel} by that name. We have ${listNames(people)}. Who would you like to see?`, ...meta });
    }
    target = match;
  } else if (people.length === 1) {
    target = people[0];
  }
  // A one-person business that is not a salon: talk about "we", not the owner's first name.
  const solo = (people.length === 1 && !isSalon) || isContractor;

  let instantISO: string | null = null;
  if (time) {
    const { data: inst } = await supabase.rpc("donna_slot_instant", { p_date: date, p_time: time, p_tz: tz });
    if (inst) instantISO = new Date(inst as string).toISOString();
  }

  if (target) {
    const who = solo ? "we" : (firstName(target.full_name) || "they");
    if (instantISO) {
      const { data: open } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: asst.account_id, p_user_id: target.id, p_start: instantISO, p_dur_min: dur, p_tz: tz });
      const busy = await busyIntervals(asst.account_id, instantISO, new Date(new Date(instantISO).getTime() + durMs).toISOString());
      const drivable = isContractor && open ? (await driveFilter(asst.account_id, target.id, [instantISO], dur, driveAddr)).has(instantISO) : true;
      if (open && drivable && notBusy(instantISO, durMs, busy)) {
        return json({ result: `Yes, ${solo ? "we're" : who + " is"} open ${fmtDay.format(new Date(instantISO))} at ${fmtTime.format(new Date(instantISO))}${svcNote}. Want me to book it?`, ...meta });
      }
    }
    const { data: slots } = await supabase.rpc("donna_available_slots_user", { p_account_id: asst.account_id, p_user_id: target.id, p_date: date, p_tz: tz, p_slot_min: 30, p_dur_min: dur });
    let all: any[] = slots ?? [];
    if (all.length) {
      const first = new Date(all[0].slot).toISOString();
      const last = new Date(new Date(all[all.length - 1].slot).getTime() + durMs).toISOString();
      const busy = await busyIntervals(asst.account_id, first, last);
      all = all.filter((s: any) => notBusy(new Date(s.slot).toISOString(), durMs, busy));
      if (isContractor && all.length) { const ok = await driveFilter(asst.account_id, target.id, all.map((s: any) => new Date(s.slot).toISOString()), dur, driveAddr); all = all.filter((s: any) => ok.has(new Date(s.slot).toISOString())); }
    }
    const open = all.filter((s: any) => inWin(new Date(s.slot).toISOString()));
    const lead = instantISO ? (solo ? "That time isn't open. " : `${who} isn't open at that time. `) : "";
    if (!all.length) return json({ result: `${lead}I don't have any openings${solo ? "" : " with " + who} on ${fmtDay.format(new Date(date + "T12:00:00Z"))}${svcNote}. Would another day work${solo ? "" : ", or would you like to see someone else"}?`, ...meta, none: true });
    if (!open.length) {
      // nothing in the window they asked for, but the day isn't empty: say what IS open and where it falls
      return json({ result: `${lead}${solo ? "We don't have" : who + " doesn't have"} anything${winTxt || " then"} on ${fmtDay.format(new Date(all[0].slot))}${svcNote}, but I do have ${say(all, 4)}. Would any of those work, or should I check another day${solo ? "" : " or someone else"}?`, ...meta, outside_window: true });
    }
    const more = open.length > 5 ? ", and a few more" : "";
    return json({ result: `${lead}${solo ? "On" : "With " + who + " on"} ${fmtDay.format(new Date(open[0].slot))}${winTxt} I have ${say(open)}${more}${svcNote}. Which works best?`, ...meta });
  }

  if (!people.length) return json({ result: "Let me take your details and have someone call you back to set that up.", ...meta });

  // Contractors with several eligible techs: one merged list of openings; the caller never picks a tech.
  if (isContractor) {
    const merged = new Map<string, any>();
    for (const p of people) {
      const mine: string[] = [];
      if (instantISO) {
        const { data: open } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: asst.account_id, p_user_id: p.id, p_start: instantISO, p_dur_min: dur, p_tz: tz });
        if (open) mine.push(instantISO);
      }
      const { data: slots } = await supabase.rpc("donna_available_slots_user", { p_account_id: asst.account_id, p_user_id: p.id, p_date: date, p_tz: tz, p_slot_min: 30, p_dur_min: dur });
      for (const s of (slots ?? []) as any[]) mine.push(new Date(s.slot).toISOString());
      // Per tech: drop the openings this tech can't drive to in time from their neighboring jobs.
      const ok = await driveFilter(asst.account_id, p.id, [...new Set(mine)], dur, driveAddr);
      for (const iso of ok) merged.set(iso, { slot: iso });
    }
    let all = [...merged.values()].sort((a, b) => a.slot.localeCompare(b.slot));
    if (all.length) { const busy = await busyIntervals(asst.account_id, all[0].slot, new Date(new Date(all[all.length - 1].slot).getTime() + durMs).toISOString()); all = all.filter((s) => notBusy(s.slot, durMs, busy)); }
    if (instantISO && all.some((s) => s.slot === instantISO)) return json({ result: `Yes, we're open ${fmtDay.format(new Date(instantISO))} at ${fmtTime.format(new Date(instantISO))}${svcNote}. Want me to book it?`, ...meta });
    const open = all.filter((s) => inWin(s.slot));
    const lead = instantISO ? "That time isn't open. " : "";
    if (!all.length) return json({ result: `${lead}I don't have any openings on ${fmtDay.format(new Date(date + "T12:00:00Z"))}${svcNote}. Would another day work?`, ...meta, none: true });
    if (!open.length) return json({ result: `${lead}We don't have anything${winTxt || " then"} on ${fmtDay.format(new Date(all[0].slot))}${svcNote}, but I do have ${say(all, 4)}. Would any of those work, or should I check another day?`, ...meta, outside_window: true });
    return json({ result: `${lead}On ${fmtDay.format(new Date(open[0].slot))}${winTxt} I have ${say(open)}${open.length > 5 ? ", and a few more" : ""}${svcNote}. Which works best?`, ...meta });
  }

  if (instantISO) {
    const busy = await busyIntervals(asst.account_id, instantISO, new Date(new Date(instantISO).getTime() + durMs).toISOString());
    const free: string[] = [];
    for (const p of people) {
      const { data: open } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: asst.account_id, p_user_id: p.id, p_start: instantISO, p_dur_min: dur, p_tz: tz });
      if (open && notBusy(instantISO, durMs, busy)) free.push(firstName(p.full_name) || p.full_name);
    }
    if (!free.length) return json({ result: `No one's open ${fmtDay.format(new Date(instantISO))} at ${fmtTime.format(new Date(instantISO))}${svcNote}. Want me to check other times that day?`, ...meta });
    const whoList = free.length === 1 ? free[0] : (free.length === 2 ? `${free[0]} and ${free[1]}` : free.slice(0, -1).join(", ") + ", and " + free[free.length - 1]);
    return json({ result: `At ${fmtTime.format(new Date(instantISO))} on ${fmtDay.format(new Date(instantISO))}, ${whoList} ${free.length === 1 ? "is" : "are"} open${svcNote}. Who would you like?`, ...meta });
  }

  const parts: string[] = [];
  let anyDay = "";
  for (const p of people) {
    const { data: slots } = await supabase.rpc("donna_available_slots_user", { p_account_id: asst.account_id, p_user_id: p.id, p_date: date, p_tz: tz, p_slot_min: 30, p_dur_min: dur });
    let open: any[] = slots ?? [];
    if (!open.length) continue;
    if (!anyDay) anyDay = fmtDay.format(new Date(open[0].slot));
    const first = new Date(open[0].slot).toISOString();
    const last = new Date(new Date(open[open.length - 1].slot).getTime() + durMs).toISOString();
    const busy = await busyIntervals(asst.account_id, first, last);
    open = open.filter((s: any) => notBusy(new Date(s.slot).toISOString(), durMs, busy)).filter((s: any) => inWin(new Date(s.slot).toISOString()));
    if (!open.length) continue;
    parts.push(`${firstName(p.full_name) || p.full_name} has ${say(open, 3)}`);
  }
  if (!parts.length) return json({ result: `I don't have any openings${winTxt} on ${fmtDay.format(new Date(date + "T12:00:00Z"))}${svcNote}. Would another time or day work?`, ...meta, none: true });
  return json({ result: `On ${anyDay || date}${winTxt}: ${parts.join("; ")}${svcNote}. Who would you like, and at what time?`, ...meta });
});
