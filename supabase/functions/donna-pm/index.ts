import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna PM sweep. Cron-triggered (*/3 min), cron-secret protected.
//  (1) Emergency backup escalation (confirm-or-escalate ladder)
//  (2) COI monitoring (remind before expiry, mark lapses)
//  (3) Stage 5: compliance reminders + overdue, meeting reminders (notice not sent / tomorrow + RSVP count),
//      stale approvals (nudge the approver once), leases ending within 60 days (office digest, once per tenant)
//  v6: the property's assigned manager (users.manager_user_id on the property or its community) is tier 0 of the
//      ladder, matching pm-request, so backup escalation walks the same list Donna started.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = `${SUPABASE_URL}/functions/v1`;
const PUBLIC_BASE = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pick = (v: unknown) => { const s = (v == null ? "" : String(v)).trim(); return s.length ? s : ""; };
const DAY = 864e5, MIN = 6e4;
function fmtWhen(iso: string | Date, tz: string) { try { const d = new Date(iso); return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d) + " at " + new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d); } catch { return String(iso); } }

async function sendEmail(from: string, to: string, subject: string, text: string, htmlBody?: string): Promise<boolean> {
  if (!RESEND_KEY || !from || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text, ...(htmlBody ? { html: htmlBody } : {}) }) }); return r.ok; } catch { return false; }
}
async function sendSms(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
const pre = (t: string) => `<pre style="font-family:system-ui,Arial,sans-serif;white-space:pre-wrap;font-size:14px">${esc(t)}</pre>`;

// The active user who manages a property: its own manager_user_id, else the parent community's.
async function propertyManager(propertyId: string | null): Promise<any | null> {
  if (!propertyId) return null;
  const { data: p } = await supabase.from("properties").select("manager_user_id, parent_property_id").eq("id", propertyId).maybeSingle();
  let uid = p?.manager_user_id || null;
  if (!uid && p?.parent_property_id) { const { data: pp } = await supabase.from("properties").select("manager_user_id").eq("id", p.parent_property_id).maybeSingle(); uid = pp?.manager_user_id || null; }
  if (!uid) return null;
  const { data: u } = await supabase.from("users").select("id, full_name, email, phone, is_active").eq("id", uid).maybeSingle();
  return u && u.is_active !== false ? u : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);
  const { data: secretRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  const cronSecret = (secretRow as any)?.value || "";
  if (!cronSecret || (req.headers.get("x-cron-secret") || "") !== cronSecret) return json({ ok: false, reason: "forbidden" }, 403);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const todayYmd = new Date(nowMs).toISOString().slice(0, 10);
  let escalated = 0, coiReminded = 0, coiExpired = 0, compReminded = 0, compOverdue = 0, mtgReminded = 0, apprNudged = 0, leaseReminded = 0;

  const { data: accts } = await supabase.from("accounts").select("id, name, settings");
  const acctMap: Record<string, any> = {};
  for (const a of (accts || []) as any[]) acctMap[a.id] = a;
  const fromFor = (acct: any) => pick((acct.settings || {}).email_reply_from) || `${acct.name} <no-reply@client.sidekicklogistics.com>`;
  const boxFor = (acct: any) => pick((acct.settings || {}).alert_email);
  const tzFor = (acct: any) => pick((acct.settings || {}).timezone) || "America/Chicago";
  const propNames: Record<string, string> = {};
  const propName = async (id: string | null) => { if (!id) return "(property)"; if (propNames[id]) return propNames[id]; const { data } = await supabase.from("properties").select("name").eq("id", id).maybeSingle(); propNames[id] = data?.name || "(property)"; return propNames[id]; };

  // ---------- (1) emergency backup escalation ----------
  const { data: open } = await supabase.from("service_requests")
    .select("id, account_id, property_id, short_ref, unit, description, escalation_state, acknowledged_at")
    .eq("status", "escalated").is("acknowledged_at", null).limit(200);
  for (const sr of (open || []) as any[]) {
    const st = sr.escalation_state || {};
    const acct = acctMap[sr.account_id]; if (!acct) continue;
    const settings = acct.settings || {};
    const ackMin = Number((settings.pm || {}).emergency_ack_minutes) || 10;
    const lastMs = st.last_notified_at ? new Date(st.last_notified_at).getTime() : 0;
    if (lastMs && (nowMs - lastMs) < ackMin * MIN) continue;
    if (st.exhausted) continue;
    const emType = st.emergency_type || "other";
    const { data: ladderRows } = await supabase.from("property_escalation_contacts").select("*").eq("account_id", sr.account_id).eq("is_active", true);
    const scoreOf = (c: any) => { let s = 0; if (sr.property_id && c.property_id === sr.property_id) s += 2; else if (!c.property_id) s += 1; else return -1; if (c.emergency_type === emType) s += 2; else if (c.emergency_type === "default") s += 1; else return -1; return s; };
    const ladder = (ladderRows || []).map((c: any) => ({ c, s: scoreOf(c) })).filter((x: any) => x.s >= 0).sort((a: any, b: any) => (b.s - a.s) || (a.c.priority - b.c.priority)).map((x: any) => x.c);
    const mgr = await propertyManager(sr.property_id);
    if (mgr && (mgr.phone || mgr.email) && !ladder.some((c: any) => (mgr.phone && c.phone === mgr.phone) || (mgr.email && c.email && String(c.email).toLowerCase() === String(mgr.email).toLowerCase()))) ladder.unshift({ name: mgr.full_name || "Property manager", email: mgr.email, phone: mgr.phone, priority: -1, source: "manager" });
    const nextTier = (typeof st.tier === "number" ? st.tier : 0) + 1;
    const from = fromFor(acct);
    const ackUrl = `${SELF}/pm-request?ack=${(await supabase.from("service_requests").select("ack_token").eq("id", sr.id).maybeSingle()).data?.ack_token || ""}`;
    const pn = await propName(sr.property_id);
    const subject = `STILL UNCONFIRMED — EMERGENCY ${emType.replace(/_/g, " ")} at ${pn} [${sr.short_ref}]`;
    const text = `No one has confirmed emergency ${sr.short_ref} (${emType.replace(/_/g, " ")}) at ${pn}${sr.unit ? ", unit " + sr.unit : ""}.\n\nReported: ${sr.description || "(no detail)"}\n\nTap to confirm you've got it: ${ackUrl}`;
    const htmlBody = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px"><p style="background:#b00020;color:#fff;padding:10px 14px;border-radius:8px;font-weight:700;margin:0 0 14px">STILL UNCONFIRMED — escalating</p><p>No one has confirmed emergency <b>${esc(sr.short_ref)}</b> (${esc(emType.replace(/_/g," "))}) at <b>${esc(pn)}</b>${sr.unit ? ", unit " + esc(sr.unit) : ""}.</p><p style="padding:12px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap">${esc(sr.description || "(no detail)")}</p><p><a href="${ackUrl}" style="background:#0f7b3b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">I've got it</a></p></div>`;
    const next = ladder[nextTier];
    const notified = Array.isArray(st.notified) ? st.notified : [];
    if (next) {
      const via: string[] = [];
      if (next.email) { if (await sendEmail(from, next.email, subject, text, htmlBody)) via.push("email"); }
      if (next.phone) { if (await sendSms(sr.account_id, next.phone, `URGENT unconfirmed: ${emType.replace(/_/g," ")} at ${pn} [${sr.short_ref}]. Confirm: ${ackUrl}`)) via.push("text"); }
      notified.push({ name: next.name, email: next.email, phone: next.phone, at: nowIso, via, tier: nextTier });
      await supabase.from("service_requests").update({ assigned_to: next.name, escalation_state: { ...st, tier: nextTier, last_notified_at: nowIso, notified } }).eq("id", sr.id);
      escalated++;
    } else {
      const box = boxFor(acct);
      if (box) await sendEmail(from, box, subject, text, htmlBody);
      await supabase.from("service_requests").update({ escalation_state: { ...st, exhausted: true, last_notified_at: nowIso, notified } }).eq("id", sr.id);
      escalated++;
    }
  }

  // ---------- (2) COI monitoring ----------
  const { data: expiring } = await supabase.from("tenant_insurance")
    .select("id, account_id, property_id, unit, tenant_name, token, status, expiration_date, reminded_at, property_contact_id")
    .in("status", ["verified", "submitted", "expired"]).not("expiration_date", "is", null).limit(500);
  for (const rec of (expiring || []) as any[]) {
    const acct = acctMap[rec.account_id]; if (!acct) continue;
    const settings = acct.settings || {};
    const windowDays = Number((settings.pm || {}).coi_reminder_days) || 30;
    const expMs = new Date(rec.expiration_date + "T00:00:00Z").getTime();
    const daysLeft = Math.floor((expMs - nowMs) / DAY);
    if (rec.expiration_date < todayYmd && rec.status !== "expired") { await supabase.from("tenant_insurance").update({ status: "expired" }).eq("id", rec.id); coiExpired++; }
    const needRemind = daysLeft <= windowDays && (!rec.reminded_at || (nowMs - new Date(rec.reminded_at).getTime()) >= 7 * DAY);
    if (!needRemind) continue;
    let email = "", phone = "";
    if (rec.property_contact_id) { const { data: pc } = await supabase.from("property_contacts").select("email, phone, contact_id").eq("id", rec.property_contact_id).maybeSingle(); if (pc) { email = pick((pc as any).email); phone = pick((pc as any).phone); if ((!email || !phone) && (pc as any).contact_id) { const { data: c } = await supabase.from("contacts").select("email, phone").eq("id", (pc as any).contact_id).maybeSingle(); if (c) { email = email || pick((c as any).email); phone = phone || pick((c as any).phone); } } } }
    if (!email && !phone) continue;
    if (!rec.token) continue;
    const business = acct.name || "Your property office";
    const pn = await propName(rec.property_id);
    const from = fromFor(acct);
    const link = `${PUBLIC_BASE}/coi/${rec.token}`;
    const lapsed = rec.expiration_date < todayYmd;
    const subject = lapsed ? `Your insurance has expired — ${business}` : `Your insurance expires soon — ${business}`;
    const body = lapsed
      ? `Hi${rec.tenant_name ? " " + rec.tenant_name : ""}, our records show your certificate of insurance for ${pn}${rec.unit ? ", unit " + rec.unit : ""} has expired. Please upload a current certificate:\n\n${link}\n\nThank you.`
      : `Hi${rec.tenant_name ? " " + rec.tenant_name : ""}, your certificate of insurance for ${pn}${rec.unit ? ", unit " + rec.unit : ""} expires on ${rec.expiration_date}. Please upload a renewed certificate when you have it:\n\n${link}\n\nThank you.`;
    let did = false;
    if (phone) did = await sendSms(rec.account_id, phone, `${business}: your insurance for ${pn}${rec.unit ? " unit " + rec.unit : ""} ${lapsed ? "has expired" : "expires " + rec.expiration_date}. Upload a current certificate: ${link}`);
    if (email) { const e = await sendEmail(from, email, subject, body); did = did || e; }
    if (did) { await supabase.from("tenant_insurance").update({ reminded_at: nowIso }).eq("id", rec.id); coiReminded++; }
  }

  // ---------- (3a) compliance: reminders + overdue ----------
  const { data: comp } = await supabase.from("pm_compliance_items").select("*").in("status", ["scheduled", "in_progress", "overdue"]).limit(500);
  for (const it of (comp || []) as any[]) {
    const acct = acctMap[it.account_id]; if (!acct) continue;
    const dueMs = new Date(it.due_date + "T12:00:00Z").getTime();
    const daysLeft = Math.floor((dueMs - nowMs) / DAY);
    if (daysLeft < 0 && it.status !== "overdue") { await supabase.from("pm_compliance_items").update({ status: "overdue" }).eq("id", it.id); compOverdue++; }
    const remindDays = Number(it.remind_days) || 30;
    const lastRem = it.reminded_at ? new Date(it.reminded_at).getTime() : 0;
    // remind at the window, then weekly, then daily once overdue (max once/day)
    const cadence = daysLeft < 0 ? 1 : 7;
    if (daysLeft <= remindDays && (!lastRem || (nowMs - lastRem) >= cadence * DAY)) {
      const box = boxFor(acct); if (!box) continue;
      const pn = await propName(it.property_id);
      const subject = daysLeft < 0 ? `OVERDUE: ${it.title} — ${pn}` : `Due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}: ${it.title} — ${pn}`;
      const text = `${it.title}${it.vendor_name ? " (" + it.vendor_name + ")" : ""} at ${pn} ${daysLeft < 0 ? "was due " + it.due_date + " and is not marked done." : "is due " + it.due_date + "."}${it.access_needed ? "\n\nThis one needs access to units/homes — use \"Schedule access\" on the property page and Donna will coordinate times with residents." : ""}${it.notes ? "\n\nNotes: " + it.notes : ""}\n\nMark it done on the property page when complete${it.frequency_months ? " (it rolls forward " + it.frequency_months + " months)" : ""}.`;
      if (await sendEmail(fromFor(acct), box, subject, text, pre(text))) { await supabase.from("pm_compliance_items").update({ reminded_at: nowIso }).eq("id", it.id); compReminded++; }
    }
  }

  // ---------- (3b) meetings: notice not sent (7d out) / tomorrow with RSVP count ----------
  const { data: mtgs } = await supabase.from("pm_meetings").select("*").eq("status", "scheduled").gte("starts_at", nowIso).lte("starts_at", new Date(nowMs + 8 * DAY).toISOString()).limit(200);
  for (const m of (mtgs || []) as any[]) {
    const acct = acctMap[m.account_id]; if (!acct) continue;
    const box = boxFor(acct); if (!box) continue;
    const hrs = (new Date(m.starts_at).getTime() - nowMs) / 36e5;
    const lastRem = m.reminded_at ? new Date(m.reminded_at).getTime() : 0;
    const stage = hrs <= 30 ? "day" : "week";
    const already = lastRem && ((stage === "week" && (nowMs - lastRem) < 5 * DAY) || (stage === "day" && (nowMs - lastRem) < 20 * 36e5));
    if (already) continue;
    const { data: rs } = await supabase.from("pm_meeting_rsvps").select("attending, proxy").eq("meeting_id", m.id);
    const att = (rs || []).filter((x: any) => x.attending && !x.proxy).length, prox = (rs || []).filter((x: any) => x.proxy).length;
    const pn = await propName(m.property_id); const tz = tzFor(acct);
    const quorum = m.quorum_required ? ` Quorum: ${att + prox}/${m.quorum_required}${att + prox >= m.quorum_required ? " ✓ met" : " — NOT yet met"}.` : "";
    const subject = stage === "day" ? `Tomorrow: ${m.title} — ${pn} (${att} attending, ${prox} proxies)` : (m.notice_sent_at ? `Next week: ${m.title} — ${pn}` : `Notice NOT sent yet: ${m.title} — ${pn}`);
    const text = `${m.title} at ${pn}\n${fmtWhen(m.starts_at, tz)}${m.location ? " · " + m.location : ""}${m.virtual_url ? " · " + m.virtual_url : ""}\n\nRSVPs so far: ${att} attending, ${prox} proxies.${quorum}${m.notice_sent_at ? "" : "\n\nThe meeting notice has NOT been sent — open the property page and tap \"Send notice\"."}${m.agenda ? "\n\nAgenda: " + m.agenda : ""}`;
    if (await sendEmail(fromFor(acct), box, subject, text, pre(text))) { await supabase.from("pm_meetings").update({ reminded_at: nowIso }).eq("id", m.id); mtgReminded++; }
  }

  // ---------- (3c) approvals pending > 3 days: nudge the approver once, copy the office ----------
  const { data: aps } = await supabase.from("pm_approvals").select("*").eq("status", "pending").is("reminded_at", null).lte("sent_at", new Date(nowMs - 3 * DAY).toISOString()).limit(100);
  for (const ap of (aps || []) as any[]) {
    const acct = acctMap[ap.account_id]; if (!acct) continue;
    const from = fromFor(acct); const aUrl = `${SELF}/pm-coordinate?approve=${ap.token}`, dUrl = `${SELF}/pm-coordinate?decline=${ap.token}`;
    const text = `Reminder from ${acct.name}: still waiting on your decision.\n\n${ap.summary || ""}${ap.amount != null ? "\nAmount: $" + Number(ap.amount).toLocaleString() : ""}\n\nApprove: ${aUrl}\nDecline: ${dUrl}`;
    let did = false;
    if (ap.approver_email) did = await sendEmail(from, ap.approver_email, `Reminder — approval needed: ${ap.summary || ""}`, text, `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px"><p>Reminder from <b>${esc(acct.name)}</b>: still waiting on your decision.</p><p><b>${esc(ap.summary || "")}</b>${ap.amount != null ? " — $" + Number(ap.amount).toLocaleString() : ""}</p><p><a href="${aUrl}" style="background:#1f7a4d;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;margin-right:8px">Approve</a><a href="${dUrl}" style="background:#b4443a;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Decline</a></p></div>`);
    if (ap.approver_phone) did = (await sendSms(ap.account_id, ap.approver_phone, `${acct.name}: reminder — approval needed for ${(ap.summary || "").slice(0, 60)}. Approve: ${aUrl}`)) || did;
    const box = boxFor(acct); if (box) await sendEmail(from, box, `Approval still pending after 3 days: ${ap.summary || ""}`, `${ap.approver_name || "The approver"} hasn't answered yet. Donna sent a reminder${did ? "" : " (delivery failed — check their contact info)"}.`);
    await supabase.from("pm_approvals").update({ reminded_at: nowIso }).eq("id", ap.id); apprNudged++;
  }

  // ---------- (3d) leases ending within 60 days: office digest, once per tenant ----------
  const { data: leases } = await supabase.from("property_contacts").select("id, account_id, property_id, name, unit, lease_end, phone, email").eq("role", "tenant").not("lease_end", "is", null).is("lease_reminded_at", null).lte("lease_end", new Date(nowMs + 60 * DAY).toISOString().slice(0, 10)).limit(200);
  const byAcct: Record<string, any[]> = {};
  for (const l of (leases || []) as any[]) (byAcct[l.account_id] = byAcct[l.account_id] || []).push(l);
  for (const [aid, rows] of Object.entries(byAcct)) {
    const acct = acctMap[aid]; if (!acct) continue; const box = boxFor(acct); if (!box) continue;
    const lines: string[] = [];
    for (const l of rows) lines.push(`${await propName(l.property_id)}${l.unit ? " · " + l.unit : ""} — ${l.name || "(tenant)"} — lease ends ${l.lease_end}${l.phone ? " · " + l.phone : ""}${l.email ? " · " + l.email : ""}`);
    const text = `Leases ending in the next 60 days:\n\n${lines.join("\n")}\n\nDecide renew / notice / list, and Donna can book the move-out inspection and showings at the unit.`;
    if (await sendEmail(fromFor(acct), box, `${rows.length} lease${rows.length === 1 ? "" : "s"} ending within 60 days`, text, pre(text))) { await supabase.from("property_contacts").update({ lease_reminded_at: nowIso }).in("id", rows.map((r: any) => r.id)); leaseReminded += rows.length; }
  }

  return json({ ok: true, escalated, coi_reminded: coiReminded, coi_expired: coiExpired, compliance_reminded: compReminded, compliance_overdue: compOverdue, meetings_reminded: mtgReminded, approvals_nudged: apprNudged, leases_reminded: leaseReminded });
});
