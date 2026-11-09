import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna estimates (v1). Donna never prices anything: the tech writes the estimate (lines from the price book or typed),
// Donna sends it, tracks it, nudges, and turns an approval into a booked job at exactly the approved total.
// Owner can require review of estimates over settings.contractor.estimate_review_over_cents before they go out.
// User actions (JWT, or service role + user_id): create | update | send | approve_review | list | convert | void
// Public (token):  approve {token} | decline {token, reason?}
// Cron (secret):   sweep  -> nudge sent estimates after 3 days, expire past expires_at

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const quoteUrl = (t: string) => `${APP}/quote/${t}`;
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
const fmtWhen = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function normLines(raw: any[]): any[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => {
    const qty = Math.max(0, Number(l.qty ?? 1) || 1);
    const unit = Math.round(Number(l.unit_cents ?? (l.unit != null ? Number(l.unit) * 100 : 0)) || 0);
    const kind = ["service", "addon", "material", "labor", "discount", "optional"].includes(l.kind) ? l.kind : "service";
    const cents = l.cents != null ? Math.round(Number(l.cents)) : Math.round(qty * unit) * (kind === "discount" ? -1 : 1);
    return { desc: String(l.desc || l.name || "").slice(0, 140), qty, unit_cents: unit, cents, kind };
  }).filter((l) => l.desc);
}
// Optional ("if we find X") lines don't count toward the total the customer approves.
const total = (lines: any[]) => lines.filter((l) => l.kind !== "optional").reduce((s, l) => s + (Number(l.cents) || 0), 0);

async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try {
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.ok) return false;
    try { const { data: cv } = await supabase.from("conversations").upsert({ account_id: accountId, channel: "sms", customer_identifier: to, last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle(); if (cv?.id) await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: cv.id, direction: "outbound", actor: "donna", channel: "sms", body, status: "sent" }); } catch { /* ok */ }
    return true;
  } catch { return false; }
}
async function sendEmail(to: string, from: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) }); return r.ok; } catch { return false; }
}
async function loadAccount(id: string) { const { data } = await supabase.from("accounts").select("id, name, settings").eq("id", id).maybeSingle(); return data as any; }
async function ownerPhones(accountId: string, createdBy: string | null): Promise<string[]> {
  const out = new Set<string>();
  if (createdBy) { const { data } = await supabase.from("users").select("phone").eq("id", createdBy).maybeSingle(); if ((data as any)?.phone) out.add((data as any).phone); }
  const { data: o } = await supabase.from("users").select("phone").eq("account_id", accountId).eq("role", "owner").not("phone", "is", null).limit(1).maybeSingle(); if ((o as any)?.phone) out.add((o as any).phone);
  return [...out];
}

async function resolveCaller(req: Request, body: any) {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i); if (!m) return null;
  if (m[1] === SERVICE_ROLE && body?.user_id) { const { data: me } = await supabase.from("users").select("id, account_id, role, full_name").eq("id", body.user_id).maybeSingle(); return me ? { userId: me.id, accountId: me.account_id, role: me.role, name: me.full_name } : null; }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role, full_name").eq("id", user.id).maybeSingle(); if (!(me as any)?.account_id) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role, name: (me as any).full_name };
}

async function doSend(acct: any, est: any): Promise<any> {
  const link = quoteUrl(est.approve_token); const tot = money(est.total_cents); const business = acct.name;
  const validDays = Number(est.valid_days) || 30; const expires = new Date(Date.now() + validDays * 86400000).toISOString();
  let sms = false, email = false;
  if (est.customer_phone && acct.settings?.sms?.enabled === true) sms = await sendText(acct.id, est.customer_phone, `${business}: your estimate ${est.number} for ${tot} is ready. Tap to view and approve: ${link} (good for ${validDays} days)`);
  if (est.customer_email) {
    const lines = (est.lines || []).map((l: any) => `  ${l.desc}${l.qty > 1 ? ` x${l.qty}` : ""}  ${l.kind === "optional" ? "(optional) " : ""}${money(l.cents)}`).join("\n");
    email = await sendEmail(est.customer_email, `${business} via Donna <donna@sidekicklogistics.com>`, `Estimate ${est.number} from ${business} - ${tot}`, `Hi${est.customer_name ? " " + est.customer_name : ""},\n\nHere is your estimate from ${business}.\n\n${lines}\n\nTotal: ${tot}\n\nView and approve: ${link}\nGood for ${validDays} days.\n\n${est.notes ? est.notes + "\n\n" : ""}Thank you,\n${business}`);
  }
  if (!sms && !email) return { ok: false, error: "not_sent", message: est.customer_phone ? "The text didn't go through." : "No phone or email on this estimate." };
  const { data } = await supabase.from("estimates").update({ status: "sent", sent_at: new Date().toISOString(), expires_at: expires, updated_at: new Date().toISOString() }).eq("id", est.id).select("*").maybeSingle();
  return { ok: true, estimate: data, sent: { sms, email }, url: link };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "list");

  // ---- Public: approve / decline by token (the quote page) ----
  if (action === "approve" || action === "decline") {
    const token = String(body.token || "").trim(); if (!token) return json({ ok: false, error: "no_token" }, 400);
    const { data: est } = await supabase.from("estimates").select("*").eq("approve_token", token).maybeSingle();
    if (!est) return json({ ok: false, error: "not_found" }, 404);
    if (!["sent", "draft", "review"].includes(est.status)) return json({ ok: false, error: "closed", status: est.status });
    if (est.expires_at && new Date(est.expires_at).getTime() < Date.now()) { await supabase.from("estimates").update({ status: "expired" }).eq("id", est.id); return json({ ok: false, error: "expired" }); }
    const acct = await loadAccount(est.account_id); const now = new Date().toISOString();
    if (action === "approve") {
      const { data } = await supabase.from("estimates").update({ status: "approved", approved_at: now, approved_via: String(body.via || "link"), updated_at: now }).eq("id", est.id).select("*").maybeSingle();
      if (est.job_id) await supabase.from("jobs").update({ lines: est.lines, updated_at: now }).eq("id", est.job_id);
      for (const p of await ownerPhones(est.account_id, est.created_by)) await sendText(est.account_id, p, `${acct.name}: ${est.customer_name || "The customer"} APPROVED estimate ${est.number} (${money(est.total_cents)})${est.service_address ? " at " + est.service_address : ""}. Reply "schedule ${est.number} <day> <time>" or book it in the app.`);
      if (est.customer_phone && acct.settings?.sms?.enabled === true) await sendText(est.account_id, est.customer_phone, `${acct.name}: thank you! Estimate ${est.number} is approved at ${money(est.total_cents)}. Reply with a day that works for you and we'll get you on the schedule.`);
      return json({ ok: true, estimate: data });
    }
    const { data } = await supabase.from("estimates").update({ status: "declined", declined_at: now, decline_reason: String(body.reason || "").slice(0, 300) || null, updated_at: now }).eq("id", est.id).select("*").maybeSingle();
    for (const p of await ownerPhones(est.account_id, est.created_by)) await sendText(est.account_id, p, `${acct.name}: ${est.customer_name || "The customer"} declined estimate ${est.number} (${money(est.total_cents)})${body.reason ? ": " + String(body.reason).slice(0, 120) : ""}.`);
    return json({ ok: true, estimate: data });
  }

  // ---- Cron: nudge + expire ----
  if (action === "sweep") {
    const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (auth !== SERVICE_ROLE && (req.headers.get("x-cron-secret") || "") !== ((sec as any)?.value || "x")) return json({ ok: false, error: "forbidden" }, 403);
    const nowIso = new Date().toISOString();
    const { data: expired } = await supabase.from("estimates").update({ status: "expired", updated_at: nowIso }).eq("status", "sent").lt("expires_at", nowIso).select("id");
    const since = new Date(Date.now() - 3 * 86400000).toISOString();
    const { data: stale } = await supabase.from("estimates").select("*").eq("status", "sent").is("nudged_at", null).lt("sent_at", since).limit(100);
    let nudged = 0;
    for (const e of (stale || []) as any[]) {
      const acct = await loadAccount(e.account_id); if (!acct) continue;
      if (e.customer_phone && acct.settings?.sms?.enabled === true) { const ok = await sendText(e.account_id, e.customer_phone, `${acct.name}: just checking in on estimate ${e.number} (${money(e.total_cents)}). Any questions? You can approve it here: ${quoteUrl(e.approve_token)}`); if (ok) nudged++; }
      await supabase.from("estimates").update({ nudged_at: nowIso }).eq("id", e.id);
    }
    return json({ ok: true, expired: (expired || []).length, nudged });
  }

  // ---- Signed-in actions ----
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const ctr: any = acct.settings?.contractor || {}; const tz = acct.settings?.timezone || "America/Chicago";
  const reviewOver = Number(ctr.estimate_review_over_cents || 0);
  const now = new Date().toISOString();

  if (action === "list") {
    let q = supabase.from("estimates").select("*").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(Math.min(200, Number(body.limit) || 50));
    if (body.status) q = q.eq("status", String(body.status));
    const { data } = await q; return json({ ok: true, estimates: (data || []).map((e: any) => ({ ...e, url: quoteUrl(e.approve_token) })) });
  }

  if (action === "create") {
    const lines = normLines(body.lines); if (!lines.length) return json({ ok: false, error: "no_lines" }, 400);
    let job: any = null; if (body.job_id) { const { data } = await supabase.from("jobs").select("*").eq("id", body.job_id).eq("account_id", acct.id).maybeSingle(); job = data; }
    const tot = total(lines);
    const needsReview = reviewOver > 0 && tot > reviewOver && !isAdmin(caller.role);
    const { data: num } = await supabase.rpc("next_estimate_number", { p_account: acct.id });
    const row: any = { account_id: acct.id, job_id: job?.id || null, contact_id: job?.contact_id || body.contact_id || null, number: num || `EST-${Date.now().toString().slice(-6)}`, status: needsReview ? "review" : "draft", lines, total_cents: tot, notes: String(body.notes || "").slice(0, 1000) || null, customer_name: String(body.customer_name || job?.customer_name || "").slice(0, 120) || null, customer_phone: String(body.customer_phone || job?.customer_phone || "").trim() || null, customer_email: String(body.customer_email || job?.customer_email || "").trim() || null, service_address: String(body.service_address || job?.address || "").slice(0, 240) || null, valid_days: Math.max(1, Math.min(180, Number(body.valid_days) || Number(ctr.estimate_valid_days) || 30)), created_by: caller.userId };
    const { data, error } = await supabase.from("estimates").insert(row).select("*").maybeSingle(); if (error) return json({ ok: false, error: error.message }, 400);
    if (needsReview) for (const p of await ownerPhones(acct.id, null)) await sendText(acct.id, p, `${acct.name}: ${String(caller.name || "a tech").split(/\s+/)[0]} wrote estimate ${data.number} for ${money(tot)} (${data.customer_name || "customer"}). It's over your review limit; approve it in the dashboard before it goes out.`);
    return json({ ok: true, estimate: data, url: quoteUrl(data.approve_token), needs_review: needsReview });
  }

  const id = String(body.id || "");
  const { data: est } = id ? await supabase.from("estimates").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle() : { data: null };
  if (!est) return json({ ok: false, error: "not_found" }, 404);

  if (action === "update") {
    if (!["draft", "review", "sent"].includes(est.status)) return json({ ok: false, error: "closed" });
    const upd: any = { updated_at: now };
    if (body.lines) { const lines = normLines(body.lines); if (!lines.length) return json({ ok: false, error: "no_lines" }, 400); upd.lines = lines; upd.total_cents = total(lines); if (reviewOver > 0 && upd.total_cents > reviewOver && !isAdmin(caller.role)) upd.status = "review"; }
    for (const k of ["notes", "customer_name", "customer_phone", "customer_email", "service_address"]) if (body[k] !== undefined) upd[k] = String(body[k] || "").trim() || null;
    if (body.valid_days) upd.valid_days = Math.max(1, Math.min(180, Number(body.valid_days)));
    const { data } = await supabase.from("estimates").update(upd).eq("id", id).select("*").maybeSingle();
    return json({ ok: true, estimate: data, url: quoteUrl(data.approve_token) });
  }
  if (action === "approve_review") {
    if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);
    const { data } = await supabase.from("estimates").update({ status: "draft", updated_at: now }).eq("id", id).select("*").maybeSingle();
    return body.send ? json(await doSend(acct, data)) : json({ ok: true, estimate: data });
  }
  if (action === "send") {
    if (est.status === "review" && !isAdmin(caller.role)) return json({ ok: false, error: "needs_review", message: `Over the owner's review limit (${money(reviewOver)}); the owner has to okay it first.` });
    if (!["draft", "review", "sent"].includes(est.status)) return json({ ok: false, error: "closed" });
    if (body.to) est.customer_phone = String(body.to).trim(); if (body.email) est.customer_email = String(body.email).trim();
    if (body.to || body.email) await supabase.from("estimates").update({ customer_phone: est.customer_phone, customer_email: est.customer_email }).eq("id", id);
    return json(await doSend(acct, est));
  }
  if (action === "void") { const { data } = await supabase.from("estimates").update({ status: "void", updated_at: now }).eq("id", id).select("*").maybeSingle(); return json({ ok: true, estimate: data }); }

  // Approved estimate -> a booked job at exactly the approved lines. new_date YYYY-MM-DD, new_time HH:MM (shop time).
  if (action === "convert") {
    if (est.status !== "approved") return json({ ok: false, error: "not_approved", message: "The customer hasn't approved it yet." });
    const newDate = String(body.new_date || "").trim(), newTime = String(body.new_time || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || !/^\d{1,2}:\d{2}$/.test(newTime)) return json({ ok: false, error: "bad_time" }, 400);
    const { data: inst } = await supabase.rpc("donna_slot_instant", { p_date: newDate, p_time: newTime, p_tz: tz }); if (!inst) return json({ ok: false, error: "bad_time" }, 400);
    const dur = Math.max(30, Math.min(600, Number(body.duration_min) || Number(ctr.job_duration_min) || 120));
    const techId = body.user_id_for || caller.userId;
    const start = new Date(inst as string); const end = new Date(start.getTime() + dur * 60000);
    const { data: open } = await supabase.rpc("donna_is_slot_open_user", { p_account_id: acct.id, p_user_id: techId, p_start: start.toISOString(), p_dur_min: dur, p_tz: tz });
    if (open === false && body.force !== true) return json({ ok: false, error: "slot_taken", message: `${fmtWhen(start.toISOString(), tz)} is already taken (or outside hours). Pick another time, or say force.` });
    const title = (est.lines || []).find((l: any) => l.kind !== "optional" && l.kind !== "discount")?.desc || "Approved work";
    const { data: appt, error: aerr } = await supabase.from("appointments").insert({ account_id: acct.id, contact_id: est.contact_id, user_id: techId, title: `${title} (${est.number})`, starts_at: start.toISOString(), ends_at: end.toISOString(), status: "scheduled", mode: "in_person", location_address: est.service_address, notes: `From estimate ${est.number}, approved ${money(est.total_cents)}.${est.notes ? " " + est.notes : ""}`, kind: "service", source: "estimate" }).select("id").maybeSingle();
    if (aerr || !appt) return json({ ok: false, error: aerr?.message || "appointment_failed" }, 400);
    const { data: job } = await supabase.from("jobs").upsert({ account_id: acct.id, appointment_id: appt.id, contact_id: est.contact_id, assigned_user_id: techId, title, kind: "service", status: "scheduled", customer_name: est.customer_name, customer_phone: est.customer_phone, customer_email: est.customer_email, address: est.service_address, scheduled_at: start.toISOString(), lines: (est.lines || []).filter((l: any) => l.kind !== "optional"), notes: `Approved estimate ${est.number}: ${money(est.total_cents)}` }, { onConflict: "appointment_id" }).select("*").maybeSingle();
    await supabase.from("estimates").update({ status: "converted", converted_job_id: job?.id || null, converted_appointment_id: appt.id, updated_at: now }).eq("id", id);
    const when = fmtWhen(start.toISOString(), tz);
    const texted = est.customer_phone && acct.settings?.sms?.enabled === true ? await sendText(acct.id, est.customer_phone, `${acct.name}: you're scheduled for ${when} (${title}, ${money(est.total_cents)} as approved). Reply here if anything changes.`) : false;
    return json({ ok: true, job, appointment_id: appt.id, when_label: when, texted });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
