import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — calendar sync sweep (v16). Runs on a schedule. Finds any appointment that
// didn't make it onto the connected calendar (pending/failed, still in the
// future, older than the inline-sync grace window) and pushes it to whichever
// provider the account uses (Google or Microsoft). Honors the tenant's selected
// calendar on both providers.
// v16: an account with NO calendar connection at all marks its appointments `skipped`
// (nothing to sync to) instead of `failed` — `failed` is reserved for a connected calendar
// that errored, so it keeps retrying every sweep.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function msCal(calId: string): string {
  const c = String(calId || "").trim(); const lc = c.toLowerCase();
  return (!c || lc === "primary" || lc === "default") ? "me" : `me/calendars/${encodeURIComponent(c)}`;
}

type Conn = {
  provider: string; access_token: string | null; refresh_token: string | null;
  token_expires_at: string | null; calendar_id: string | null; status: string;
};
type Access = { token: string; calendarId: string; provider: string };
type AccessResult = { access: Access | null; hasConnection: boolean };

const accessCache = new Map<string, AccessResult>();
const tzCache = new Map<string, string>();

const SECRET_KEYS: Record<string, [string, string]> = {
  google: ["google_client_id", "google_client_secret"],
  microsoft: ["microsoft_client_id", "microsoft_client_secret"],
};

async function getAccess(accountId: string): Promise<AccessResult> {
  if (accessCache.has(accountId)) return accessCache.get(accountId)!;
  const done = (r: AccessResult) => { accessCache.set(accountId, r); return r; };

  const { data } = await supabase
    .from("calendar_connections")
    .select("provider, access_token, refresh_token, token_expires_at, calendar_id, status")
    .eq("account_id", accountId).eq("status", "connected")
    .order("updated_at", { ascending: false }).limit(1);
  const conn = data?.[0] as Conn | undefined;
  if (!conn || !conn.refresh_token) return done({ access: null, hasConnection: !!conn });

  const provider = conn.provider;
  const calendarId = conn.calendar_id || "primary";
  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token && expMs - Date.now() > 120000) {
    return done({ access: { token: conn.access_token, calendarId, provider }, hasConnection: true });
  }

  const keys = SECRET_KEYS[provider];
  if (!keys) return done({ access: null, hasConnection: true });
  const { data: secrets } = await supabase.from("app_secrets").select("key,value").in("key", keys);
  const map: Record<string, string> = Object.fromEntries((secrets ?? []).map((r: any) => [r.key, r.value]));
  const cid = map[keys[0]], csec = map[keys[1]];
  if (!cid || !csec) return done({ access: null, hasConnection: true });

  const res = provider === "google"
    ? await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token" }),
      })
    : await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token!, grant_type: "refresh_token", scope: "offline_access https://graph.microsoft.com/Calendars.ReadWrite" }),
      });
  const tok: any = await res.json();
  if (!res.ok || !tok.access_token) return done({ access: null, hasConnection: true });
  const newExp = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const upd: Record<string, unknown> = { access_token: tok.access_token, token_expires_at: newExp, status: "connected", last_error: null, updated_at: new Date().toISOString() };
  if (tok.refresh_token) upd.refresh_token = tok.refresh_token;
  await supabase.from("calendar_connections").update(upd).eq("account_id", accountId).eq("provider", provider);
  return done({ access: { token: tok.access_token, calendarId, provider }, hasConnection: true });
}

async function tzFor(accountId: string): Promise<string> {
  if (tzCache.has(accountId)) return tzCache.get(accountId)!;
  const { data: a } = await supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle();
  const tz = ((a as any)?.settings?.timezone) || "America/Chicago";
  tzCache.set(accountId, tz); return tz;
}

async function pushEvent(acc: Access, appt: any, tz: string): Promise<{ ok: boolean; id: string | null }> {
  if (acc.provider === "google") {
    const event = {
      summary: appt.title || "Appointment",
      description: appt.notes || "Booked by Donna.",
      start: { dateTime: new Date(appt.starts_at).toISOString(), timeZone: tz },
      end: { dateTime: new Date(appt.ends_at).toISOString(), timeZone: tz },
    };
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(acc.calendarId)}/events`,
      { method: "POST", headers: { "Authorization": `Bearer ${acc.token}`, "Content-Type": "application/json" }, body: JSON.stringify(event) },
    );
    const ev: any = await res.json();
    if (!res.ok) return { ok: false, id: null };
    return { ok: true, id: ev.id ?? null };
  }

  const event = {
    subject: appt.title || "Appointment",
    body: { contentType: "text", content: appt.notes || "Booked by Donna." },
    start: { dateTime: new Date(appt.starts_at).toISOString().replace("Z", ""), timeZone: "UTC" },
    end: { dateTime: new Date(appt.ends_at).toISOString().replace("Z", ""), timeZone: "UTC" },
  };
  const res = await fetch(`https://graph.microsoft.com/v1.0/${msCal(acc.calendarId)}/events`, {
    method: "POST", headers: { "Authorization": `Bearer ${acc.token}`, "Content-Type": "application/json" }, body: JSON.stringify(event),
  });
  const ev: any = await res.json();
  if (!res.ok) return { ok: false, id: null };
  return { ok: true, id: ev.id ?? null };
}

Deno.serve(async (_req: Request) => {
  const graceCutoff = new Date(Date.now() - 120000).toISOString();
  const nowIso = new Date().toISOString();

  const { data: appts } = await supabase
    .from("appointments")
    .select("id, account_id, title, starts_at, ends_at, notes")
    .in("sync_status", ["pending", "failed"])
    .gt("starts_at", nowIso)
    .lt("created_at", graceCutoff)
    .order("created_at", { ascending: true })
    .limit(50);

  let synced = 0, failed = 0, skipped = 0;
  for (const a of appts ?? []) {
    const { access, hasConnection } = await getAccess(a.account_id);
    if (!access) {
      if (!hasConnection) { await supabase.from("appointments").update({ sync_status: "skipped" }).eq("id", a.id); skipped++; continue; }
      await supabase.from("appointments").update({ sync_status: "failed" }).eq("id", a.id); failed++; continue;
    }
    const tz = await tzFor(a.account_id);
    const result = await pushEvent(access, a, tz);
    if (!result.ok) { await supabase.from("appointments").update({ sync_status: "failed" }).eq("id", a.id); failed++; continue; }
    await supabase.from("appointments").update({
      external_event_id: result.id, external_provider: access.provider,
      sync_status: "synced", synced_at: new Date().toISOString(),
    }).eq("id", a.id);
    synced++;
  }

  return json({ checked: (appts ?? []).length, synced, failed, skipped });
});
