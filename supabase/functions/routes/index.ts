import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna recurring routes (v1). Standing work that repeats on a cadence: weekly lawn, biweekly pool, monthly filter change,
// quarterly pest. Donna generates the visits ahead of time (lead_days) as real appointments + jobs, so they show on the
// tech's day, get the normal reminders, and invoice with one tap from the saved lines. Skips, pauses and seasons are
// honored by the generator. Donna never prices: the lines come from the tech/owner.
// User actions (JWT, or service role + user_id): create | update | list | pause | resume | skip {id,date} | unskip | delete | preview {id}
// Cron (secret) / service role: generate -> creates visits for every active route through today+lead_days

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
const FREQ = ["weekly", "biweekly", "monthly", "quarterly"];

function normLines(raw: any[]): any[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => {
    const qty = Math.max(0, Number(l.qty ?? 1) || 1);
    const unit = Math.round(Number(l.unit_cents ?? (l.unit != null ? Number(l.unit) * 100 : 0)) || 0);
    const kind = ["service", "addon", "material", "labor", "discount"].includes(l.kind) ? l.kind : "service";
    const cents = l.cents != null ? Math.round(Number(l.cents)) : Math.round(qty * unit) * (kind === "discount" ? -1 : 1);
    return { desc: String(l.desc || l.name || "").slice(0, 140), qty, unit_cents: unit, cents, kind };
  }).filter((l) => l.desc);
}
// Local calendar date (YYYY-MM-DD) in a zone.
function todayIn(tz: string): string { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const monthOf = (d: string) => Number(d.slice(5, 7));

// Every date the route lands on inside [from, to], honoring cadence, season and skips.
function occurrences(r: any, from: string, to: string): string[] {
  const out: string[] = [];
  const season: number[] = Array.isArray(r.season_months) ? r.season_months.map(Number) : [];
  const skips = new Set<string>((r.skip_dates || []).map((x: any) => String(x).slice(0, 10)));
  const anchor = String(r.anchor_date || from).slice(0, 10);
  for (let d = from; d <= to; d = addDays(d, 1)) {
    let hit = false;
    if (r.frequency === "weekly") hit = dow(d) === Number(r.weekday ?? dow(anchor));
    else if (r.frequency === "biweekly") hit = dow(d) === Number(r.weekday ?? dow(anchor)) && Math.floor(daysBetween(anchor, d) / 7) % 2 === 0;
    else if (r.frequency === "monthly") hit = Number(d.slice(8, 10)) === Number(r.day_of_month || Number(anchor.slice(8, 10)) || 1);
    else if (r.frequency === "quarterly") { const dm = Number(r.day_of_month || Number(anchor.slice(8, 10)) || 1); const monthsApart = (Number(d.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + (monthOf(d) - monthOf(anchor)); hit = Number(d.slice(8, 10)) === dm && monthsApart % 3 === 0; }
    if (!hit) continue;
    if (d < anchor) continue;
    if (season.length && !season.includes(monthOf(d))) continue;
    if (skips.has(d)) continue;
    out.push(d);
  }
  return out;
}

async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SUPA_URL}/functions/v1/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}

// Create the appointment + job for one route date. Idempotent on (recurring_id, route_date).
async function materialize(acct: any, r: any, date: string, tz: string): Promise<{ created: boolean; job_id?: string; reason?: string }> {
  const { data: existing } = await supabase.from("jobs").select("id").eq("recurring_id", r.id).eq("route_date", date).maybeSingle();
  if (existing) return { created: false, reason: "exists" };
  const { data: inst } = await supabase.rpc("donna_slot_instant", { p_date: date, p_time: r.time_local || "09:00", p_tz: tz });
  if (!inst) return { created: false, reason: "bad_time" };
  const start = new Date(inst as string); const end = new Date(start.getTime() + (Number(r.duration_min) || 60) * 60000);
  const { data: appt, error } = await supabase.from("appointments").insert({ account_id: acct.id, contact_id: r.contact_id, user_id: r.assigned_user_id, title: r.title, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "scheduled", mode: "in_person", location_address: r.address, notes: `Recurring (${r.frequency}).${r.notes ? " " + r.notes : ""}`, kind: "service", source: "route" }).select("id").maybeSingle();
  if (error || !appt) return { created: false, reason: error?.message || "appointment_failed" };
  const { data: job, error: jerr } = await supabase.from("jobs").insert({ account_id: acct.id, appointment_id: appt.id, contact_id: r.contact_id, assigned_user_id: r.assigned_user_id, title: r.title, kind: "route", status: "scheduled", customer_name: r.customer_name, customer_phone: r.customer_phone, customer_email: r.customer_email, address: r.address, scheduled_at: start.toISOString(), lines: r.lines || [], notes: r.notes || null, recurring_id: r.id, route_date: date }).select("id").maybeSingle();
  if (jerr) { await supabase.from("appointments").delete().eq("id", appt.id); return { created: false, reason: jerr.message }; }
  return { created: true, job_id: job?.id };
}

async function generateFor(acct: any, routes: any[]): Promise<{ created: number; skipped: number }> {
  const tz = acct.settings?.timezone || "America/Chicago";
  const today = todayIn(tz);
  let created = 0, skipped = 0;
  for (const r of routes) {
    if (r.paused) continue;
    const to = addDays(today, Math.max(1, Math.min(60, Number(r.lead_days) || 14)));
    for (const d of occurrences(r, today, to)) {
      const res = await materialize(acct, r, d, tz);
      if (res.created) created++; else skipped++;
    }
    await supabase.from("recurring_jobs").update({ last_generated_date: to, updated_at: new Date().toISOString() }).eq("id", r.id);
  }
  return { created, skipped };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "list");
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let trusted = auth === SERVICE_ROLE;
  if (!trusted) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); trusted = !!(sec as any)?.value && (req.headers.get("x-cron-secret") || "") === (sec as any).value; }

  if (action === "generate") {
    if (!trusted) return json({ ok: false, error: "forbidden" }, 403);
    const { data: routes } = await supabase.from("recurring_jobs").select("*").eq("paused", false).limit(2000);
    const byAcct = new Map<string, any[]>(); for (const r of (routes || []) as any[]) { if (body.account_id && r.account_id !== body.account_id) continue; byAcct.set(r.account_id, [...(byAcct.get(r.account_id) || []), r]); }
    let created = 0, skipped = 0;
    for (const [aid, list] of byAcct) { const { data: acct } = await supabase.from("accounts").select("id, name, settings").eq("id", aid).maybeSingle(); if (!acct) continue; const r = await generateFor(acct, list); created += r.created; skipped += r.skipped; }
    return json({ ok: true, routes: (routes || []).length, created, skipped });
  }

  // Everything else acts as a user.
  let userId = String(body.user_id || ""), accountId = "", role = "";
  if (trusted && userId) { const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", userId).maybeSingle(); if (!me) return json({ ok: false, error: "unauthorized" }, 401); accountId = me.account_id; role = me.role; }
  else {
    const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
    const { data: { user } } = await userClient.auth.getUser(auth); if (!user) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", user.id).maybeSingle(); if (!(me as any)?.account_id) return json({ ok: false, error: "unauthorized" }, 401);
    userId = me!.id; accountId = me!.account_id; role = me!.role;
  }
  const { data: acct } = await supabase.from("accounts").select("id, name, settings").eq("id", accountId).maybeSingle(); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const tz = acct.settings?.timezone || "America/Chicago";

  if (action === "list") {
    const { data } = await supabase.from("recurring_jobs").select("*").eq("account_id", accountId).order("paused").order("title");
    const today = todayIn(tz);
    return json({ ok: true, routes: (data || []).map((r: any) => ({ ...r, next_dates: occurrences(r, today, addDays(today, 120)).slice(0, 3) })) });
  }

  if (action === "create") {
    const title = String(body.title || "").trim().slice(0, 140); if (!title) return json({ ok: false, error: "no_title" }, 400);
    const frequency = FREQ.includes(body.frequency) ? body.frequency : "weekly";
    let contact: any = null;
    if (body.contact_id) { const { data } = await supabase.from("contacts").select("id, name, phone, email").eq("id", body.contact_id).eq("account_id", accountId).maybeSingle(); contact = data; }
    const row: any = {
      account_id: accountId, contact_id: contact?.id || null, assigned_user_id: body.assigned_user_id || userId, title, lines: normLines(body.lines),
      customer_name: String(body.customer_name || contact?.name || "").slice(0, 120) || null, customer_phone: String(body.customer_phone || contact?.phone || "").trim() || null,
      customer_email: String(body.customer_email || contact?.email || "").trim() || null, address: String(body.address || "").slice(0, 240) || null,
      frequency, weekday: body.weekday != null ? Number(body.weekday) : null, day_of_month: body.day_of_month != null ? Math.min(28, Math.max(1, Number(body.day_of_month))) : null,
      time_local: /^\d{1,2}:\d{2}$/.test(String(body.time_local || "")) ? body.time_local : "09:00", duration_min: Math.max(15, Math.min(600, Number(body.duration_min) || 60)),
      season_months: Array.isArray(body.season_months) ? body.season_months.map(Number).filter((m: number) => m >= 1 && m <= 12) : [],
      lead_days: Math.max(1, Math.min(60, Number(body.lead_days) || 14)), anchor_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date || "")) ? body.start_date : todayIn(tz),
      notes: String(body.notes || "").slice(0, 1000) || null, created_by: userId,
    };
    if ((frequency === "weekly" || frequency === "biweekly") && row.weekday == null) row.weekday = dow(row.anchor_date);
    if ((frequency === "monthly" || frequency === "quarterly") && row.day_of_month == null) row.day_of_month = Math.min(28, Number(row.anchor_date.slice(8, 10)));
    const { data, error } = await supabase.from("recurring_jobs").insert(row).select("*").maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    const gen = await generateFor(acct, [data]);
    const today = todayIn(tz);
    return json({ ok: true, route: data, generated: gen.created, next_dates: occurrences(data, today, addDays(today, 120)).slice(0, 3) });
  }

  const id = String(body.id || "");
  if (["update", "pause", "resume", "skip", "unskip", "delete", "preview"].includes(action)) {
    const { data: r } = await supabase.from("recurring_jobs").select("*").eq("id", id).eq("account_id", accountId).maybeSingle();
    if (!r) return json({ ok: false, error: "not_found" }, 404);
    if (!isAdmin(role) && r.assigned_user_id !== userId && r.created_by !== userId) return json({ ok: false, error: "forbidden" }, 403);
    const today = todayIn(tz);

    if (action === "preview") return json({ ok: true, next_dates: occurrences(r, today, addDays(today, 365)).slice(0, 8) });

    if (action === "update") {
      const upd: any = { updated_at: new Date().toISOString() };
      for (const k of ["title", "customer_name", "customer_phone", "customer_email", "address", "notes", "time_local"]) if (body[k] !== undefined) upd[k] = String(body[k] || "").trim() || null;
      if (body.lines) upd.lines = normLines(body.lines);
      if (body.frequency && FREQ.includes(body.frequency)) upd.frequency = body.frequency;
      if (body.weekday !== undefined) upd.weekday = body.weekday == null ? null : Number(body.weekday);
      if (body.day_of_month !== undefined) upd.day_of_month = body.day_of_month == null ? null : Math.min(28, Math.max(1, Number(body.day_of_month)));
      if (body.duration_min) upd.duration_min = Math.max(15, Math.min(600, Number(body.duration_min)));
      if (body.season_months) upd.season_months = body.season_months.map(Number).filter((m: number) => m >= 1 && m <= 12);
      if (body.assigned_user_id) upd.assigned_user_id = body.assigned_user_id;
      if (body.lead_days) upd.lead_days = Math.max(1, Math.min(60, Number(body.lead_days)));
      if (upd.time_local && !/^\d{1,2}:\d{2}$/.test(upd.time_local)) delete upd.time_local;
      const { data } = await supabase.from("recurring_jobs").update(upd).eq("id", id).select("*").maybeSingle();
      // Future generated visits that haven't started follow the new schedule: drop and regenerate.
      if (body.reschedule_future !== false && (upd.frequency || upd.weekday !== undefined || upd.day_of_month !== undefined || upd.time_local || upd.duration_min || upd.assigned_user_id)) {
        const { data: fut } = await supabase.from("jobs").select("id, appointment_id").eq("recurring_id", id).eq("status", "scheduled").gte("route_date", today);
        for (const j of (fut || []) as any[]) { await supabase.from("jobs").delete().eq("id", j.id); if (j.appointment_id) await supabase.from("appointments").delete().eq("id", j.appointment_id); }
        await generateFor(acct, [data]);
      }
      return json({ ok: true, route: data, next_dates: occurrences(data, today, addDays(today, 120)).slice(0, 3) });
    }

    if (action === "pause" || action === "resume") {
      const paused = action === "pause";
      const { data } = await supabase.from("recurring_jobs").update({ paused, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
      if (paused) {
        const { data: fut } = await supabase.from("jobs").select("id, appointment_id").eq("recurring_id", id).eq("status", "scheduled").gte("route_date", today);
        for (const j of (fut || []) as any[]) { await supabase.from("jobs").delete().eq("id", j.id); if (j.appointment_id) await supabase.from("appointments").delete().eq("id", j.appointment_id); }
      } else await generateFor(acct, [data]);
      return json({ ok: true, route: data });
    }

    if (action === "skip" || action === "unskip") {
      const date = String(body.date || "").slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "bad_date" }, 400);
      const set = new Set<string>((r.skip_dates || []).map((x: any) => String(x).slice(0, 10)));
      if (action === "skip") set.add(date); else set.delete(date);
      const { data } = await supabase.from("recurring_jobs").update({ skip_dates: [...set], updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
      if (action === "skip") {
        const { data: j } = await supabase.from("jobs").select("id, appointment_id, customer_phone").eq("recurring_id", id).eq("route_date", date).maybeSingle();
        if (j) { await supabase.from("jobs").delete().eq("id", j.id); if (j.appointment_id) await supabase.from("appointments").delete().eq("id", j.appointment_id); if (body.tell_customer === true && j.customer_phone && acct.settings?.sms?.enabled === true) await sendText(accountId, j.customer_phone, `${acct.name}: we'll skip your ${r.title.toLowerCase()} visit on ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(date + "T12:00:00Z"))}. Your regular schedule continues after that.`); }
      } else await generateFor(acct, [data]);
      return json({ ok: true, route: data, next_dates: occurrences(data, today, addDays(today, 120)).slice(0, 3) });
    }

    if (action === "delete") {
      const { data: fut } = await supabase.from("jobs").select("id, appointment_id").eq("recurring_id", id).eq("status", "scheduled").gte("route_date", today);
      for (const j of (fut || []) as any[]) { await supabase.from("jobs").delete().eq("id", j.id); if (j.appointment_id) await supabase.from("appointments").delete().eq("id", j.appointment_id); }
      await supabase.from("recurring_jobs").delete().eq("id", id);
      return json({ ok: true, removed_future: (fut || []).length });
    }
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
