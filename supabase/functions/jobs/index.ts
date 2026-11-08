import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna jobs (v1): the contractor's day. A job wraps an appointment (created lazily) and carries the
// on-my-way / started / done timeline, proposed invoice lines, notes and photos.
// Actions (user JWT, or service role + user_id from the text-command layer):
//   today {date?}                      -> this user's jobs for the day (managers: whole company)
//   job {job_id|appointment_id}        -> job + proposed lines + add-on menu
//   en_route {job, minutes?}           -> texts the customer "on the way", sets status
//   start {job}                        -> in progress
//   done {job}                         -> status done, returns proposed lines + menu for the confirm step
//   finalize {job, lines, notes?}      -> builds the invoice (via payments), returns total + pay_url (nothing sent yet)
//   note {job, text}                   -> append a note
// Sending / marking paid stays in `payments` (invoice_send / invoice_mark_paid) so every vertical shares it.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
const parsePrice = (p: any): number | null => { const m = String(p ?? "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/); return m ? Math.round(parseFloat(m[1]) * 100) : null; };
const firstName = (n: string) => String(n || "").trim().split(/\s+/)[0] || "Your technician";

async function resolveCaller(req: Request, body: any): Promise<{ userId: string; accountId: string; role: string; authHeader: string } | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const m = authHeader.match(/Bearer\s+(.+)/i); if (!m) return null;
  // Internal callers (text-command layer) use the service role and pass user_id.
  if (m[1] === SERVICE_ROLE && body?.user_id) {
    const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", body.user_id).maybeSingle();
    return me ? { userId: me.id, accountId: me.account_id, role: me.role, authHeader } : null;
  }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role").eq("id", user.id).maybeSingle();
  if (!(me as any)?.account_id) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role, authHeader };
}

function dayRange(dateStr: string | undefined, tz: string) {
  const now = new Date();
  const ymd = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  // Find the UTC instant of local midnight by probing the offset at noon that day.
  const probe = new Date(`${ymd}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" }).formatToParts(probe);
  const localHour = Number(parts.find((p) => p.type === "hour")?.value || "12") % 24;
  const offsetH = localHour - 12; // local = utc + offset
  const start = new Date(`${ymd}T00:00:00Z`); start.setUTCHours(start.getUTCHours() - offsetH);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { ymd, start: start.toISOString(), end: end.toISOString() };
}

async function ensureJob(acct: any, ref: { job_id?: string; appointment_id?: string }) {
  if (ref.job_id) { const { data } = await supabase.from("jobs").select("*").eq("id", ref.job_id).eq("account_id", acct.id).maybeSingle(); return data; }
  if (!ref.appointment_id) return null;
  const { data: existing } = await supabase.from("jobs").select("*").eq("appointment_id", ref.appointment_id).maybeSingle();
  if (existing) return existing;
  const { data: a } = await supabase.from("appointments").select("id, account_id, contact_id, user_id, title, starts_at, status, location_address, notes, customer_email, appointment_type_id, appointment_types(name, price, kind), contacts(name, phone, email)").eq("id", ref.appointment_id).eq("account_id", acct.id).maybeSingle();
  if (!a) return null;
  const t: any = (a as any).appointment_types || {}; const c: any = (a as any).contacts || {};
  const row = { account_id: acct.id, appointment_id: a.id, contact_id: a.contact_id, assigned_user_id: a.user_id, title: t.name || a.title || "Job", kind: /estimate|quote/i.test(t.name || "") ? "estimate" : "service", status: a.status === "cancelled" ? "cancelled" : "scheduled", customer_name: c.name || null, customer_phone: c.phone || null, customer_email: c.email || a.customer_email || null, address: a.location_address || null, scheduled_at: a.starts_at, notes: a.notes || null };
  const { data } = await supabase.from("jobs").upsert(row, { onConflict: "appointment_id" }).select("*").maybeSingle();
  return data;
}

// Proposed invoice lines at Done: the booked service at its menu price (after-hours multiplier if set), plus the trip fee rule.
async function proposeLines(acct: any, job: any) {
  const cfg = acct.settings?.contractor || {};
  const tz = acct.settings?.timezone || "America/Chicago";
  let types: any[] = [];
  { const { data } = await supabase.from("appointment_types").select("id, name, price, kind, category, is_active").eq("account_id", acct.id).eq("is_active", true).order("name"); types = data || []; }
  let booked: any = null;
  if (job.appointment_id) { const { data: a } = await supabase.from("appointments").select("appointment_type_id, starts_at").eq("id", job.appointment_id).maybeSingle(); booked = a ? types.find((t) => t.id === a.appointment_type_id) : null; }
  const lines: any[] = [];
  const when = new Date(job.scheduled_at || Date.now());
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" }).format(when)) % 24;
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(when);
  const afterHours = Number(cfg.after_hours_multiplier || 0) > 1 && (hour < Number(cfg.day_start_hour ?? 7) || hour >= Number(cfg.day_end_hour ?? 19) || dow === "Sun");
  if (booked) {
    const base = parsePrice(booked.price);
    if (base != null) { const cents = afterHours ? Math.round(base * Number(cfg.after_hours_multiplier)) : base; lines.push({ desc: booked.name + (afterHours ? " (after hours)" : ""), qty: 1, unit_cents: cents, cents, kind: "service" }); }
    else lines.push({ desc: booked.name, qty: 1, unit_cents: 0, cents: 0, kind: "service", needs_price: true });
  } else if (job.title) lines.push({ desc: job.title, qty: 1, unit_cents: 0, cents: 0, kind: "service", needs_price: true });
  const trip = Number(cfg.trip_fee_cents || 0);
  if (trip > 0) { const waived = cfg.trip_fee_waived_if_work !== false; lines.push({ desc: waived ? "Trip fee (waived, work done)" : "Trip fee", qty: 1, unit_cents: trip, cents: waived ? 0 : trip, kind: "trip_fee" }); }
  const menu = types.filter((t) => !booked || t.id !== booked.id).map((t) => ({ id: t.id, name: t.name, cents: parsePrice(t.price), category: t.category || null }));
  return { lines, menu, after_hours: afterHours };
}

async function textCustomer(acct: any, to: string, text: string) {
  if (!to || acct.settings?.sms?.enabled !== true) return false;
  try {
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: acct.id, to, body: text }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.ok) return false;
    try { const { data: cv } = await supabase.from("conversations").upsert({ account_id: acct.id, channel: "sms", customer_identifier: to, last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle(); if (cv?.id) await supabase.from("conversation_messages").insert({ account_id: acct.id, conversation_id: cv.id, direction: "outbound", actor: "donna", channel: "sms", body: text, status: "sent" }); } catch { /* ok */ }
    return true;
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: acct } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", caller.accountId).maybeSingle();
  if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const action = String(body.action || "today");
  const tz = acct.settings?.timezone || "America/Chicago";
  const ref = { job_id: body.job_id, appointment_id: body.appointment_id };

  if (action === "today") {
    const { ymd, start, end } = dayRange(body.date, tz);
    let q = supabase.from("appointments").select("id, title, starts_at, ends_at, status, user_id, location_address, notes, contact_id, appointment_type_id, appointment_types(name, price), contacts(name, phone), users(full_name)").eq("account_id", acct.id).gte("starts_at", start).lt("starts_at", end).neq("status", "cancelled").order("starts_at");
    if (!isAdmin(caller.role) || body.mine) q = q.eq("user_id", caller.userId);
    const { data: appts } = await q;
    const ids = (appts || []).map((a: any) => a.id);
    const { data: jobs } = ids.length ? await supabase.from("jobs").select("*").in("appointment_id", ids) : { data: [] as any[] };
    const byAppt = new Map((jobs || []).map((j: any) => [j.appointment_id, j]));
    const out = (appts || []).map((a: any) => { const j: any = byAppt.get(a.id); return { appointment_id: a.id, job_id: j?.id || null, title: a.appointment_types?.name || a.title, price: a.appointment_types?.price || null, starts_at: a.starts_at, ends_at: a.ends_at, customer_name: a.contacts?.name || j?.customer_name || null, customer_phone: a.contacts?.phone || j?.customer_phone || null, address: a.location_address || j?.address || null, notes: a.notes, tech: a.users?.full_name || null, user_id: a.user_id, status: j?.status || (a.status === "completed" ? "done" : "scheduled"), invoice_id: j?.invoice_id || null, eta_minutes: j?.eta_minutes || null }; });
    return json({ ok: true, date: ymd, jobs: out });
  }

  const job = await ensureJob(acct, ref);
  if (!job) return json({ ok: false, error: "job_not_found" }, 404);
  if (!isAdmin(caller.role) && job.assigned_user_id && job.assigned_user_id !== caller.userId) return json({ ok: false, error: "not_your_job" }, 403);
  const now = new Date().toISOString();
  const custFirst = String(job.customer_name || "").split(/\s+/)[0] || "";

  if (action === "job") { const p = await proposeLines(acct, job); return json({ ok: true, job, proposed: p.lines, menu: p.menu }); }

  if (action === "en_route") {
    const mins = Math.max(0, Math.min(240, Number(body.minutes) || 0));
    const { data: tech } = await supabase.from("users").select("full_name").eq("id", caller.userId).maybeSingle();
    const who = firstName((tech as any)?.full_name || "");
    const text = `${acct.name}: ${who} is on the way${custFirst ? `, ${custFirst}` : ""}${mins ? `, about ${mins} minutes out` : ""}.${job.address ? "" : ""} Reply here if anything changes.`;
    const sent = await textCustomer(acct, job.customer_phone, text);
    const { data } = await supabase.from("jobs").update({ status: "en_route", en_route_at: now, eta_minutes: mins || null, updated_at: now }).eq("id", job.id).select("*").maybeSingle();
    return json({ ok: true, job: data, texted: sent, text });
  }

  if (action === "start") {
    const { data } = await supabase.from("jobs").update({ status: "in_progress", started_at: now, updated_at: now }).eq("id", job.id).select("*").maybeSingle();
    return json({ ok: true, job: data });
  }

  if (action === "done") {
    const p = await proposeLines(acct, job);
    const { data } = await supabase.from("jobs").update({ status: job.invoice_id ? job.status : "done", done_at: job.done_at || now, lines: job.lines?.length ? job.lines : p.lines, updated_at: now }).eq("id", job.id).select("*").maybeSingle();
    if (job.appointment_id) { try { await supabase.from("appointments").update({ status: "completed" }).eq("id", job.appointment_id).neq("status", "cancelled"); } catch { /* status enum may differ */ } }
    const subtotal = (data?.lines || []).reduce((s: number, l: any) => s + (l.cents || 0), 0);
    return json({ ok: true, job: data, proposed: data?.lines || p.lines, menu: p.menu, subtotal_cents: subtotal, subtotal: money(subtotal), after_hours: p.after_hours, has_invoice: !!job.invoice_id });
  }

  if (action === "finalize") {
    if (job.invoice_id) { const { data: inv } = await supabase.from("invoices").select("*").eq("id", job.invoice_id).maybeSingle(); if (inv && !inv.paid_at && inv.status !== "void") return json({ ok: true, invoice: inv, total: money(inv.total_cents), pay_url: `https://donna-dashboard-three.vercel.app/pay/${inv.pay_token}`, existing: true }); }
    const lines = Array.isArray(body.lines) && body.lines.length ? body.lines : job.lines;
    if (!lines?.length) return json({ ok: false, error: "no_lines" }, 400);
    const payload = { action: "invoice_create", job_id: job.id, appointment_id: job.appointment_id, contact_id: job.contact_id, customer_name: job.customer_name, customer_phone: job.customer_phone, customer_email: job.customer_email, service_address: job.address, lines, notes: body.notes ?? null, user_id: caller.userId };
    const r = await fetch(`${SELF}/payments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: caller.authHeader }, body: JSON.stringify(payload) });
    const j: any = await r.json().catch(() => ({}));
    if (!j?.ok) return json({ ok: false, error: j?.error || "invoice_failed" }, 400);
    await supabase.from("jobs").update({ invoice_id: j.invoice.id, lines: j.invoice.lines, status: "done", updated_at: now }).eq("id", job.id);
    return json({ ok: true, invoice: j.invoice, total: money(j.invoice.total_cents), pay_url: j.pay_url });
  }

  if (action === "note") {
    const text = String(body.text || "").trim().slice(0, 1000); if (!text) return json({ ok: false, error: "empty" }, 400);
    const stamp = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date());
    const notes = (job.notes ? job.notes + "\n" : "") + `[${stamp}] ${text}`;
    const { data } = await supabase.from("jobs").update({ notes, updated_at: now }).eq("id", job.id).select("*").maybeSingle();
    return json({ ok: true, job: data });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
