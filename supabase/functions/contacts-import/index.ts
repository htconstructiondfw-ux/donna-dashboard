import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — contacts-import (v1). Pull the owner's address book from the Google / Microsoft account they already connected
// for calendar (same OAuth grant; the dashboard now asks for the contacts scopes too). No export, no CSV:
//   status            -> which accounts are connected and when contacts were last pulled
//   pull {provider?}  -> read Google People (contacts + "other contacts" they've emailed) or Microsoft Graph (contacts + people),
//                        dedupe by phone then email, upsert into contacts (source 'import'), never overwrite a name the owner typed.
// Owners/admins (JWT), or service role / cron secret acting as a user (setup, sweeps).

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (d.startsWith("+")) { d = "+" + d.slice(1).replace(/\D/g, ""); } else if (/^\d{10}$/.test(d)) d = "+1" + d; else if (/^1\d{10}$/.test(d)) d = "+" + d; else if (d) d = "+" + d; return /^\+\d{10,15}$/.test(d) ? d : ""; };
const normEmail = (e: string) => String(e || "").trim().toLowerCase();

async function resolveCaller(req: Request, body?: any) {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i); if (!m) return null;
  let internal = m[1] === SERVICE_ROLE;
  if (!internal && req.headers.get("x-cron-secret")) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); internal = !!(sec as any)?.value && req.headers.get("x-cron-secret") === (sec as any).value; }
  if (internal && body?.user_id) { const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", body.user_id).maybeSingle(); return me ? { userId: me.id, accountId: me.account_id, role: me.role } : null; }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role").eq("id", user.id).maybeSingle();
  return (me as any)?.account_id ? { userId: user.id, accountId: (me as any).account_id, role: (me as any).role } : null;
}
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());

const SECRET_KEYS: Record<string, [string, string]> = { google: ["google_client_id", "google_client_secret"], microsoft: ["microsoft_client_id", "microsoft_client_secret"] };
const MS_SCOPE = "offline_access https://graph.microsoft.com/Contacts.Read https://graph.microsoft.com/People.Read https://graph.microsoft.com/User.Read";
// A fresh access token for this connection. Google refresh tokens carry every scope granted; Microsoft lets us ask for the contacts subset.
async function accessFor(conn: any): Promise<string | null> {
  const expMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (conn.access_token && expMs - Date.now() > 120000 && conn.provider === "google") return conn.access_token;
  const keys = SECRET_KEYS[conn.provider]; if (!keys || !conn.refresh_token) return null;
  const { data: secrets } = await supabase.from("app_secrets").select("key,value").in("key", keys);
  const map: Record<string, string> = Object.fromEntries((secrets ?? []).map((r: any) => [r.key, r.value]));
  const cid = map[keys[0]], csec = map[keys[1]]; if (!cid || !csec) return null;
  const res = conn.provider === "google"
    ? await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token, grant_type: "refresh_token" }) })
    : await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: conn.refresh_token, grant_type: "refresh_token", scope: MS_SCOPE }) });
  const tok: any = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) { console.error("refresh", conn.provider, res.status, JSON.stringify(tok).slice(0, 200)); return null; }
  // Don't disturb the calendar sweep's token for Microsoft (different scope set); for Google it is the same token.
  if (conn.provider === "google") { const upd: any = { access_token: tok.access_token, token_expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null, updated_at: new Date().toISOString() }; if (tok.refresh_token) upd.refresh_token = tok.refresh_token; await supabase.from("calendar_connections").update(upd).eq("id", conn.id); }
  return tok.access_token;
}

type Person = { name: string; phone: string; email: string; company: string; kind: "contact" | "other" };
async function pullGoogle(token: string): Promise<{ people: Person[]; scopeError: boolean }> {
  const people: Person[] = []; let scopeError = false;
  const h = { Authorization: `Bearer ${token}` };
  const conv = (p: any, kind: Person["kind"]): Person => ({ name: p.names?.[0]?.displayName || [p.names?.[0]?.givenName, p.names?.[0]?.familyName].filter(Boolean).join(" ") || "", phone: normPhone((p.phoneNumbers || []).find((x: any) => /mobile|cell|main|work|home/i.test(x.type || "mobile"))?.value || p.phoneNumbers?.[0]?.value || ""), email: normEmail(p.emailAddresses?.[0]?.value || ""), company: p.organizations?.[0]?.name || "", kind });
  let pageToken = ""; let guard = 0;
  do { const r = await fetch(`https://people.googleapis.com/v1/people/me/connections?personFields=names,phoneNumbers,emailAddresses,organizations&pageSize=1000${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`, { headers: h }); if (r.status === 403) { scopeError = true; break; } const j: any = await r.json().catch(() => ({})); if (!r.ok) { console.error("people", r.status, JSON.stringify(j).slice(0, 200)); break; } for (const p of (j.connections || [])) people.push(conv(p, "contact")); pageToken = j.nextPageToken || ""; } while (pageToken && ++guard < 10);
  pageToken = ""; guard = 0;
  do { const r = await fetch(`https://people.googleapis.com/v1/otherContacts?readMask=names,phoneNumbers,emailAddresses&pageSize=1000${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`, { headers: h }); if (!r.ok) break; const j: any = await r.json().catch(() => ({})); for (const p of (j.otherContacts || [])) people.push(conv(p, "other")); pageToken = j.nextPageToken || ""; } while (pageToken && ++guard < 10);
  return { people, scopeError };
}
async function pullMicrosoft(token: string): Promise<{ people: Person[]; scopeError: boolean }> {
  const people: Person[] = []; let scopeError = false; const h = { Authorization: `Bearer ${token}` };
  let url = "https://graph.microsoft.com/v1.0/me/contacts?$top=500&$select=displayName,givenName,surname,mobilePhone,businessPhones,homePhones,emailAddresses,companyName"; let guard = 0;
  while (url && guard++ < 10) { const r = await fetch(url, { headers: h }); if (r.status === 403 || r.status === 401) { scopeError = true; break; } const j: any = await r.json().catch(() => ({})); if (!r.ok) break; for (const c of (j.value || [])) people.push({ name: c.displayName || [c.givenName, c.surname].filter(Boolean).join(" ") || "", phone: normPhone(c.mobilePhone || c.businessPhones?.[0] || c.homePhones?.[0] || ""), email: normEmail(c.emailAddresses?.[0]?.address || ""), company: c.companyName || "", kind: "contact" }); url = j["@odata.nextLink"] || ""; }
  url = "https://graph.microsoft.com/v1.0/me/people?$top=500&$select=displayName,scoredEmailAddresses,phones,companyName"; guard = 0;
  while (url && guard++ < 6) { const r = await fetch(url, { headers: h }); if (!r.ok) break; const j: any = await r.json().catch(() => ({})); for (const c of (j.value || [])) people.push({ name: c.displayName || "", phone: normPhone((c.phones || []).find((p: any) => /mobile|business|home/i.test(p.type || "mobile"))?.number || c.phones?.[0]?.number || ""), email: normEmail(c.scoredEmailAddresses?.[0]?.address || ""), company: c.companyName || "", kind: "other" }); url = j["@odata.nextLink"] || ""; }
  return { people, scopeError };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);
  const action = String(body.action || "status");
  const { data: conns } = await supabase.from("calendar_connections").select("id, provider, external_account, status, access_token, refresh_token, token_expires_at, updated_at").eq("account_id", caller.accountId).in("status", ["connected", "inactive"]).order("updated_at", { ascending: false });
  const { data: acct } = await supabase.from("accounts").select("settings").eq("id", caller.accountId).maybeSingle();
  const s: any = acct?.settings || {};
  if (action === "status") return json({ ok: true, connections: (conns || []).map((c: any) => ({ provider: c.provider, account: c.external_account, status: c.status })), last: s.contacts_import || null });

  if (action === "pull") {
    const want = body.provider ? String(body.provider) : null;
    const list = (conns || []).filter((c: any) => !want || c.provider === want);
    if (!list.length) return json({ ok: false, error: "not_connected", message: "Connect Google or Microsoft first." });
    const { data: existing } = await supabase.from("contacts").select("id, name, phone, email").eq("account_id", caller.accountId).limit(20000);
    const byPhone = new Map<string, any>(), byEmail = new Map<string, any>();
    for (const c of (existing || [])) { const p = normPhone(c.phone || ""); if (p && !byPhone.has(p)) byPhone.set(p, c); const e = normEmail(c.email || ""); if (e && !byEmail.has(e)) byEmail.set(e, c); }
    let found = 0, added = 0, updated = 0, skipped = 0; const report: any[] = []; const seen = new Set<string>();
    for (const conn of list) {
      const token = await accessFor(conn); if (!token) { report.push({ provider: conn.provider, account: conn.external_account, error: "needs_reconnect" }); continue; }
      const { people, scopeError } = conn.provider === "google" ? await pullGoogle(token) : await pullMicrosoft(token);
      if (scopeError) { report.push({ provider: conn.provider, account: conn.external_account, error: "needs_reconnect" }); continue; }
      found += people.length;
      const inserts: any[] = []; const now = new Date().toISOString();
      for (const p of people) {
        if (!p.phone && !p.email) { skipped++; continue; }
        if (!p.name && p.kind === "other" && !p.phone) { skipped++; continue; } // bare addresses from mail: not a client
        const key = p.phone || p.email; if (seen.has(key)) continue; seen.add(key);
        const hit = (p.phone && byPhone.get(p.phone)) || (p.email && byEmail.get(p.email));
        if (hit) { const upd: any = {}; if (!hit.name && p.name) upd.name = p.name; if (!hit.email && p.email) upd.email = p.email; if (!hit.phone && p.phone) upd.phone = p.phone; if (Object.keys(upd).length) { upd.updated_at = now; await supabase.from("contacts").update(upd).eq("id", hit.id); updated++; } continue; }
        inserts.push({ account_id: caller.accountId, name: p.name || null, phone: p.phone || null, email: p.email || null, company: p.company || null, source: "import", list_type: "normal", updated_at: now });
      }
      for (let i = 0; i < inserts.length; i += 200) { const chunk = inserts.slice(i, i + 200); const { error } = await supabase.from("contacts").insert(chunk); if (error) { console.error("insert", error.message); const { error: e2 } = await supabase.from("contacts").upsert(chunk, { onConflict: "account_id,phone", ignoreDuplicates: true }); if (!e2) added += chunk.length; } else added += chunk.length; }
      report.push({ provider: conn.provider, account: conn.external_account, found: people.length });
    }
    const settings: any = Object.assign({}, s, { contacts_import: { at: new Date().toISOString(), found, added, updated, report } });
    await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
    const needs = report.filter((r) => r.error === "needs_reconnect").map((r) => r.provider);
    return json({ ok: true, found, added, updated, skipped, report, needs_reconnect: needs });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
