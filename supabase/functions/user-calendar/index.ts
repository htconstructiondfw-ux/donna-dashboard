import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — per-person calendars (v1). Each team member can connect their own Google or Outlook calendar
// (user_calendar_connections, separate from the company calendar in calendar_connections). Every sweep:
//   1. push   — their Donna appointments onto their calendar: create new, move rescheduled, remove cancelled
//               or reassigned (appointments.user_event_* columns track the mirror)
//   2. pull   — their busy time for the next 30 days into calendar_blocks (source 'calendar'), so the phone,
//               the booking page and the dashboard all stop offering times they're busy. Donna's own events
//               are skipped, and so is anything marked free / transparent.
// Actions:
//   sweep {user_id?, force?}   internal (x-cron-secret or service role); cron every 2 minutes, pulls every 10
//   sync_me                     the signed-in person: sweep just me, now

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const PULL_EVERY_MS = 10 * 60 * 1000;
const PULL_DAYS = 30;
const LIVE = ["scheduled", "confirmed"];

type Conn = { id: string; account_id: string; user_id: string; provider: string; calendar_id: string | null; access_token: string | null; refresh_token: string | null; token_expires_at: string | null; last_pulled_at: string | null };

let SECRETS: Record<string, string> | null = null;
async function secrets(): Promise<Record<string, string>> {
  if (SECRETS) return SECRETS;
  const { data } = await supabase.from("app_secrets").select("key,value").in("key", ["google_client_id", "google_client_secret", "microsoft_client_id", "microsoft_client_secret", "cron_secret"]);
  SECRETS = Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value])); return SECRETS!;
}
async function token(c: Conn): Promise<string | null> {
  const exp = c.token_expires_at ? new Date(c.token_expires_at).getTime() : 0;
  if (c.access_token && exp - Date.now() > 120000) return c.access_token;
  if (!c.refresh_token) return null;
  const s = await secrets();
  const res = c.provider === "google"
    ? await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: s.google_client_id, client_secret: s.google_client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" }) })
    : await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: s.microsoft_client_id, client_secret: s.microsoft_client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token", scope: "offline_access https://graph.microsoft.com/Calendars.ReadWrite" }) });
  const t: any = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) { await supabase.from("user_calendar_connections").update({ status: "error", last_error: `Sign-in expired (${t.error || res.status}). Reconnect your calendar.`, updated_at: new Date().toISOString() }).eq("id", c.id); return null; }
  const upd: any = { access_token: t.access_token, token_expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, status: "connected", last_error: null, updated_at: new Date().toISOString() };
  if (t.refresh_token) upd.refresh_token = t.refresh_token;
  await supabase.from("user_calendar_connections").update(upd).eq("id", c.id);
  return t.access_token;
}
const gCal = (c: Conn) => encodeURIComponent(c.calendar_id || "primary");
const msCal = (c: Conn) => { const id = String(c.calendar_id || "").trim(); return !id || /^(primary|default)$/i.test(id) ? "me" : `me/calendars/${encodeURIComponent(id)}`; };

// ---------------------------------------------------------------- push
function eventBody(c: Conn, a: any, tz: string) {
  const title = a.title || a.appointment_types?.name || "Appointment";
  const notes = [a.notes, a.location_address ? `Where: ${a.location_address}` : "", "Booked by Donna"].filter(Boolean).join("\n");
  const end = a.ends_at || new Date(new Date(a.starts_at).getTime() + 30 * 60000).toISOString();
  if (c.provider === "google") return { summary: title, description: notes, location: a.location_address || undefined, start: { dateTime: new Date(a.starts_at).toISOString(), timeZone: tz }, end: { dateTime: new Date(end).toISOString(), timeZone: tz } };
  return { subject: title, body: { contentType: "text", content: notes }, location: a.location_address ? { displayName: a.location_address } : undefined, start: { dateTime: new Date(a.starts_at).toISOString().replace("Z", ""), timeZone: "UTC" }, end: { dateTime: new Date(end).toISOString().replace("Z", ""), timeZone: "UTC" } };
}
async function createEv(c: Conn, tok: string, body: any): Promise<string | null> {
  const r = c.provider === "google"
    ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/${gCal(c)}/events`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    : await fetch(`https://graph.microsoft.com/v1.0/${msCal(c)}/events`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({})); return r.ok ? (j.id || null) : null;
}
async function patchEv(c: Conn, tok: string, id: string, body: any): Promise<boolean> {
  const r = c.provider === "google"
    ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/${gCal(c)}/events/${encodeURIComponent(id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    : await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.ok;
}
async function deleteEv(c: Conn, tok: string, id: string): Promise<boolean> {
  const r = c.provider === "google"
    ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/${gCal(c)}/events/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } })
    : await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
  return r.ok || r.status === 404 || r.status === 410; // already gone counts as removed
}
async function push(c: Conn, tok: string, tz: string) {
  const out = { created: 0, moved: 0, removed: 0, failed: 0 };
  const since = new Date(Date.now() - 86400000).toISOString();
  // Removed: cancelled, or now assigned to someone else, while the event is still on this person's calendar.
  const { data: gone } = await supabase.from("appointments").select("id, user_id, status, user_event_id").eq("user_event_user", c.user_id).not("user_event_id", "is", null).neq("user_sync_status", "deleted").gte("starts_at", since).limit(100);
  for (const a of gone ?? []) {
    if (a.user_id === c.user_id && LIVE.includes(a.status)) continue;
    if (await deleteEv(c, tok, a.user_event_id)) { out.removed++; await supabase.from("appointments").update({ user_event_id: null, user_event_user: null, user_sync_status: "deleted" }).eq("id", a.id); }
    else out.failed++;
  }
  // New and moved.
  const { data: mine } = await supabase.from("appointments").select("id, title, notes, starts_at, ends_at, status, location_address, user_event_id, user_event_user, user_synced_start, user_synced_end, appointment_types(name)").eq("user_id", c.user_id).in("status", LIVE).gt("starts_at", new Date().toISOString()).order("starts_at").limit(200);
  for (const a of mine ?? []) {
    const end = a.ends_at || new Date(new Date(a.starts_at).getTime() + 30 * 60000).toISOString();
    // Reassigned from someone whose calendar still holds it: their sweep removes it first, then we add it here.
    if (a.user_event_id && a.user_event_user && a.user_event_user !== c.user_id) {
      const { count } = await supabase.from("user_calendar_connections").select("id", { count: "exact", head: true }).eq("user_id", a.user_event_user);
      if (count) continue;
    }
    if (!a.user_event_id || a.user_event_user !== c.user_id) {
      const id = await createEv(c, tok, eventBody(c, a, tz));
      if (!id) { out.failed++; await supabase.from("appointments").update({ user_sync_status: "failed" }).eq("id", a.id); continue; }
      out.created++; await supabase.from("appointments").update({ user_event_id: id, user_event_provider: c.provider, user_event_user: c.user_id, user_synced_start: a.starts_at, user_synced_end: end, user_sync_status: "synced" }).eq("id", a.id);
    } else if (new Date(a.user_synced_start || 0).getTime() !== new Date(a.starts_at).getTime() || new Date(a.user_synced_end || 0).getTime() !== new Date(end).getTime()) {
      if (await patchEv(c, tok, a.user_event_id, eventBody(c, a, tz))) { out.moved++; await supabase.from("appointments").update({ user_synced_start: a.starts_at, user_synced_end: end, user_sync_status: "synced" }).eq("id", a.id); }
      else out.failed++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- pull
// Midnight of a calendar date in the account's time zone, as an instant.
function midnightIn(date: string, tz: string): Date {
  const guess = new Date(date + "T00:00:00Z");
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value || 0);
  const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}
async function pull(c: Conn, tok: string, tz: string): Promise<number | null> {
  const from = new Date(), to = new Date(Date.now() + PULL_DAYS * 86400000);
  const { data: ours } = await supabase.from("appointments").select("user_event_id").eq("user_event_user", c.user_id).not("user_event_id", "is", null);
  const skip = new Set((ours ?? []).map((r: any) => r.user_event_id));
  const busy: { s: string; e: string }[] = [];
  if (c.provider === "google") {
    let pageToken = "";
    for (let i = 0; i < 4; i++) {
      const u = `https://www.googleapis.com/calendar/v3/calendars/${gCal(c)}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } }); if (!r.ok) return null;
      const j: any = await r.json();
      for (const e of j.items ?? []) {
        if (e.status === "cancelled" || e.transparency === "transparent" || skip.has(e.id)) continue;
        const me = (e.attendees || []).find((x: any) => x.self); if (me && me.responseStatus === "declined") continue;
        const s = e.start?.dateTime ? new Date(e.start.dateTime) : (e.start?.date ? midnightIn(e.start.date, tz) : null);
        const en = e.end?.dateTime ? new Date(e.end.dateTime) : (e.end?.date ? midnightIn(e.end.date, tz) : null);
        if (s && en && en > s) busy.push({ s: s.toISOString(), e: en.toISOString() });
      }
      if (!j.nextPageToken) break; pageToken = j.nextPageToken;
    }
  } else {
    let u = `https://graph.microsoft.com/v1.0/${msCal(c)}/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=id,start,end,showAs,isCancelled,isAllDay&$top=250`;
    for (let i = 0; i < 4 && u; i++) {
      const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}`, Prefer: 'outlook.timezone="UTC"' } }); if (!r.ok) return null;
      const j: any = await r.json();
      for (const e of j.value ?? []) {
        if (e.isCancelled || e.showAs === "free" || skip.has(e.id)) continue;
        const iso = (dt: any) => { let s = String(dt?.dateTime || ""); if (!s) return null; if (!/Z$/.test(s)) s = s.replace(/(\.\d+)?$/, "") + "Z"; return new Date(s); };
        const s = e.isAllDay ? midnightIn(String(e.start?.dateTime || "").slice(0, 10), tz) : iso(e.start);
        const en = e.isAllDay ? midnightIn(String(e.end?.dateTime || "").slice(0, 10), tz) : iso(e.end);
        if (s && en && en > s) busy.push({ s: s.toISOString(), e: en.toISOString() });
      }
      u = j["@odata.nextLink"] || "";
    }
  }
  await supabase.from("calendar_blocks").delete().eq("user_id", c.user_id).eq("source", "calendar");
  if (busy.length) await supabase.from("calendar_blocks").insert(busy.slice(0, 600).map((b) => ({ account_id: c.account_id, user_id: c.user_id, block_type: "busy", starts_at: b.s, ends_at: b.e, reason: "Busy on my calendar", source: "calendar" })));
  await supabase.from("user_calendar_connections").update({ last_pulled_at: new Date().toISOString(), status: "connected", last_error: null }).eq("id", c.id);
  return busy.length;
}

async function sweepOne(c: Conn, force: boolean) {
  const tok = await token(c); if (!tok) return { user_id: c.user_id, error: "token" };
  const { data: a } = await supabase.from("accounts").select("settings").eq("id", c.account_id).maybeSingle();
  const tz = (a as any)?.settings?.timezone || "America/Chicago";
  const p = await push(c, tok, tz);
  let pulled: number | null | undefined;
  if (force || !c.last_pulled_at || Date.now() - new Date(c.last_pulled_at).getTime() > PULL_EVERY_MS || p.removed || p.moved) pulled = await pull(c, tok, tz);
  return { user_id: c.user_id, ...p, pulled };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "sweep");
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const cronHdr = req.headers.get("x-cron-secret") || "";
  const internal = auth === SERVICE_ROLE || (!!cronHdr && cronHdr === (await secrets()).cron_secret);
  const cols = "id, account_id, user_id, provider, calendar_id, access_token, refresh_token, token_expires_at, last_pulled_at";

  if (action === "sweep") {
    if (!internal) return json({ ok: false, error: "internal_only" }, 403);
    let q = supabase.from("user_calendar_connections").select(cols).in("status", ["connected", "error"]);
    if (body.user_id) q = q.eq("user_id", body.user_id);
    const { data: conns } = await q.limit(200);
    const results = [];
    for (const c of (conns ?? []) as Conn[]) { try { results.push(await sweepOne(c, !!body.force)); } catch (e) { results.push({ user_id: c.user_id, error: String((e as any)?.message || e) }); } }
    return json({ ok: true, people: results.length, results });
  }
  if (action === "sync_me") {
    const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
    const { data: { user } } = await userClient.auth.getUser(auth); if (!user) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: c } = await supabase.from("user_calendar_connections").select(cols).eq("user_id", user.id).maybeSingle();
    if (!c) return json({ ok: false, error: "not_connected" });
    return json({ ok: true, ...(await sweepOne(c as Conn, true)) });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
