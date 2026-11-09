import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna drive time (v1). Real driving minutes between a tech's neighboring jobs and a proposed one, from the
// Google Distance Matrix API when GOOGLE_MAPS_API_KEY (env) or app_secrets.google_maps_api_key is set.
// Without a key it falls back to the account's flat travel buffer (settings.contractor.travel_buffer_min, already
// enforced in donna_is_slot_open_user) and passes everything through, so booking never depends on Google being up.
// Internal (service role / cron secret):
//   filter {account_id, user_id, slots:[iso], dur_min, address}  -> slots that leave enough drive time either side
//   check  {account_id, user_id, start_iso, dur_min, address}    -> {fits, before, after}
//   eta    {account_id, origin, dest}                            -> {minutes, source}

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const PAD_MIN = 5; // park, walk up, knock

let KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") || ""; let keyAt = 0;
async function ensureKey(): Promise<string> {
  if (KEY) return KEY;
  if (Date.now() - keyAt < 60_000) return KEY;
  keyAt = Date.now();
  try { const { data } = await supabase.from("app_secrets").select("value").eq("key", "google_maps_api_key").maybeSingle(); KEY = String((data as any)?.value || "").trim(); } catch { /* */ }
  return KEY;
}
// Per-instance cache of driving minutes; traffic-aware where Google returns it. Keyed "origin|dest".
const cache = new Map<string, { min: number; at: number }>();
const norm = (s: string) => String(s || "").trim().replace(/\s+/g, " ");
async function matrix(origins: string[], dests: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = await ensureKey(); if (!key || !origins.length || !dests.length) return out;
  const need = new Set<string>();
  for (const o of origins) for (const d of dests) { const k = `${norm(o)}|${norm(d)}`; const c = cache.get(k); if (c && Date.now() - c.at < 20 * 60_000) out.set(k, c.min); else if (norm(o) === norm(d)) out.set(k, 0); else need.add(k); }
  if (!need.size) return out;
  const os = [...new Set([...need].map((k) => k.split("|")[0]))], ds = [...new Set([...need].map((k) => k.split("|")[1]))];
  // Distance Matrix caps 25 origins/25 destinations and 100 elements per request.
  for (let i = 0; i < os.length; i += 10) {
    const oChunk = os.slice(i, i + 10);
    for (let j = 0; j < ds.length; j += 10) {
      const dChunk = ds.slice(j, j + 10);
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&mode=driving&departure_time=now&origins=${encodeURIComponent(oChunk.join("|"))}&destinations=${encodeURIComponent(dChunk.join("|"))}&key=${key}`;
      try {
        const r = await fetch(url); const j: any = await r.json().catch(() => ({}));
        if (j?.status !== "OK") { console.error("distance matrix", j?.status, j?.error_message); continue; }
        (j.rows || []).forEach((row: any, oi: number) => (row.elements || []).forEach((el: any, di: number) => {
          if (el?.status !== "OK") return;
          const secs = Number(el.duration_in_traffic?.value ?? el.duration?.value ?? 0);
          const min = Math.ceil(secs / 60); const k = `${oChunk[oi]}|${dChunk[di]}`;
          cache.set(k, { min, at: Date.now() }); out.set(k, min);
        }));
      } catch (e) { console.error("distance matrix threw", String(e)); }
    }
  }
  return out;
}

async function neighbors(accountId: string, userId: string, fromIso: string, toIso: string) {
  const { data } = await supabase.from("appointments").select("id, starts_at, ends_at, location_address, mode").eq("account_id", accountId).eq("user_id", userId).in("status", ["scheduled", "confirmed"]).gte("ends_at", new Date(new Date(fromIso).getTime() - 8 * 3600_000).toISOString()).lte("starts_at", new Date(new Date(toIso).getTime() + 8 * 3600_000).toISOString()).order("starts_at");
  return ((data || []) as any[]).filter((a) => a.location_address);
}

// For one proposed slot: the job just before and just after it (same tech), and the minutes free either side.
function around(appts: any[], startIso: string, durMin: number) {
  const s = new Date(startIso).getTime(), e = s + durMin * 60000;
  let prev: any = null, next: any = null;
  for (const a of appts) { const ae = new Date(a.ends_at || a.starts_at).getTime(), as = new Date(a.starts_at).getTime(); if (ae <= s && (!prev || ae > new Date(prev.ends_at).getTime())) prev = a; if (as >= e && (!next || as < new Date(next.starts_at).getTime())) next = a; }
  return { prev, next, gapBefore: prev ? Math.round((s - new Date(prev.ends_at).getTime()) / 60000) : null, gapAfter: next ? Math.round((new Date(next.starts_at).getTime() - e) / 60000) : null };
}

Deno.serve(async (req: Request) => {
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let trusted = auth === SERVICE_ROLE;
  if (!trusted) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); trusted = !!(sec as any)?.value && (req.headers.get("x-cron-secret") || "") === (sec as any).value; }
  if (!trusted) return json({ ok: false, error: "forbidden" }, 403);
  const action = String(body.action || "check");
  const key = await ensureKey();
  const source = key ? "google" : "buffer";

  if (action === "eta") {
    const o = norm(body.origin), d = norm(body.dest); if (!o || !d) return json({ ok: false, error: "need_origin_dest" }, 400);
    const m = await matrix([o], [d]); const min = m.get(`${o}|${d}`);
    return json({ ok: true, source, minutes: min ?? null });
  }

  const accountId = String(body.account_id || ""), userId = String(body.user_id || ""), address = norm(body.address);
  const dur = Math.max(15, Number(body.dur_min) || 60);
  const slots: string[] = action === "filter" ? (Array.isArray(body.slots) ? body.slots.map((s: any) => new Date(typeof s === "string" ? s : s.slot).toISOString()) : []) : [new Date(String(body.start_iso)).toISOString()];
  if (!accountId || !userId || !slots.length) return json({ ok: false, error: "need_account_user_slots" }, 400);
  if (!key || !address) return json({ ok: true, source: "buffer", slots, fits: true, dropped: 0, note: key ? "no address" : "no Google Maps key; flat travel buffer applies" });

  const appts = await neighbors(accountId, userId, slots[0], slots[slots.length - 1]);
  const ctx = slots.map((s) => ({ slot: s, ...around(appts, s, dur) }));
  const prevAddrs = [...new Set(ctx.filter((c) => c.prev).map((c) => norm(c.prev.location_address)))];
  const nextAddrs = [...new Set(ctx.filter((c) => c.next).map((c) => norm(c.next.location_address)))];
  const [toHere, fromHere] = await Promise.all([matrix(prevAddrs, [address]), matrix([address], nextAddrs)]);
  const kept: string[] = []; const detail: any[] = [];
  for (const c of ctx) {
    const before = c.prev ? toHere.get(`${norm(c.prev.location_address)}|${address}`) : null;
    const after = c.next ? fromHere.get(`${address}|${norm(c.next.location_address)}`) : null;
    const okBefore = before == null || c.gapBefore == null || c.gapBefore >= before + PAD_MIN;
    const okAfter = after == null || c.gapAfter == null || c.gapAfter >= after + PAD_MIN;
    const fits = okBefore && okAfter;
    if (fits) kept.push(c.slot);
    detail.push({ slot: c.slot, fits, drive_before_min: before, gap_before_min: c.gapBefore, drive_after_min: after, gap_after_min: c.gapAfter });
  }
  if (action === "check") { const d = detail[0]; return json({ ok: true, source, fits: d.fits, ...d }); }
  return json({ ok: true, source, slots: kept, dropped: slots.length - kept.length, detail });
});
