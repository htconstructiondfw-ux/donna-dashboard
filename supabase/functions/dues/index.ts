import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — HOA / community dues (v2). PM Donna and Real Estate Donna (community managers).
//
// Decisions (Hubert, Nov 10 2026): dues monthly or annually per community (+ one-off assessments); FULL amount only;
// autopay with bank debit (ACH, no fee) as the default and card at the community's card fee (3%); one Stripe connected
// account per community (the association is the merchant of record); payout to the HOA monthly. Donna never holds money.
//
//   communities_list                       -> communities with live tiles (units, autopay, open, late, collected)
//   community_save {community}             -> create / update (name, address, frequency, due_day, due_month, dues_cents, grace_days, late_fee_cents, card_fee_pct, notify_days_before, payout_schedule, payout_day)
//   community_remove {id}
//   community_connect {id}                 -> Stripe Accounts v2 for THIS community (card + ACH), hosted onboarding link
//   community_refresh {id}                 -> mirror Stripe status into communities
//   units_list {community_id}
//   unit_save {unit} / unit_remove {id}
//   units_import {community_id, text}      -> pasted roster (one home per line: address/lot, owner, phone, email, dues) -> units
//   run {community_id, period?}            -> create + send this period's dues invoices (idempotent per unit+period)
//   assessment {community_id, desc, amount_cents, due_at, unit_ids?} -> one-off special assessment
//   status {community_id, period} / delinquent {community_id} / collected {community_id, from, to} / ledger {unit_id, year}
//   autopay_link {unit_id, method?} / autopay_cancel {unit_id}
//   lookup_by_phone {phone}                -> the caller's unit(s) + open dues (for Donna on the phone / text)
//   sweep                                  -> cron, daily: generate -> remind -> autopay -> late fee
//   (Retell tool call, body.call)          -> "what do I owe?" spoken answer + pay link texted to the number on file
//
// Money moves only through `payments` (checkout, autopay charge, autopay enrollment); this function owns the schedule.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (/^\d{10}$/.test(d)) d = "+1" + d; if (/^1\d{10}$/.test(d)) d = "+" + d; return /^\+1\d{10}$/.test(d) ? d : ""; };
const payUrl = (token: string) => `${APP}/pay/${token}`;
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());

// Stripe (Accounts v2 for the per-community merchant account). Same secret source as `payments`.
let STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || ""; let keyAt = 0;
async function stripeKey(): Promise<string> { if (STRIPE_KEY) return STRIPE_KEY; if (Date.now() - keyAt < 60_000) return STRIPE_KEY; keyAt = Date.now(); try { const { data } = await supabase.from("app_secrets").select("value").eq("key", "stripe_secret_key").maybeSingle(); STRIPE_KEY = String((data as any)?.value || "").trim(); } catch { /* */ } return STRIPE_KEY; }
const V2_VERSION = "2026-10-28.endive";
async function stripeV2(method: string, path: string, body?: any): Promise<any> {
  const key = await stripeKey(); if (!key) throw new Error("stripe_not_configured");
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Stripe-Version": V2_VERSION, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`stripe_v2 ${method} ${path}: ${j?.error?.message || j?.message || r.status}`);
  return j;
}
async function stripeV1Form(path: string, form: Record<string, string>, stripeAccount?: string): Promise<any> {
  const key = await stripeKey(); if (!key) throw new Error("stripe_not_configured");
  const h: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }; if (stripeAccount) h["Stripe-Account"] = stripeAccount;
  const r = await fetch(`https://api.stripe.com${path}`, { method: "POST", headers: h, body: new URLSearchParams(form).toString() });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`stripe ${path}: ${j?.error?.message || r.status}`); return j;
}

type Caller = { userId: string; accountId: string; role: string; internal: boolean };
async function resolveCaller(req: Request, body: any): Promise<Caller | null> {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i);
  if (!m && !req.headers.get("x-cron-secret")) return null;
  let internal = !!m && m[1] === SERVICE_ROLE;
  if (!internal && req.headers.get("x-cron-secret")) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); internal = !!(sec as any)?.value && req.headers.get("x-cron-secret") === (sec as any).value; }
  if (internal) {
    if (body?.user_id) { const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", body.user_id).maybeSingle(); return me ? { userId: me.id, accountId: me.account_id, role: me.role, internal: true } : null; }
    return { userId: "", accountId: String(body?.account_id || ""), role: "owner", internal: true };
  }
  if (!m) return null;
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role").eq("id", user.id).maybeSingle();
  if (!(me as any)?.account_id) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role, internal: false };
}
async function ownerUserId(accountId: string): Promise<string | null> { const { data } = await supabase.from("users").select("id").eq("account_id", accountId).eq("role", "owner").order("created_at").limit(1).maybeSingle(); return (data as any)?.id || null; }
async function paymentsApi(userId: string, body: any): Promise<any> {
  try { const r = await fetch(`${SELF}/payments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ ...body, user_id: userId }) }); return await r.json().catch(() => ({})); } catch (e) { return { ok: false, error: String(e) }; }
}
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
async function smsOn(accountId: string): Promise<boolean> { const { data } = await supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle(); return (data as any)?.settings?.sms?.enabled === true; }

// ---------------------------------------------------------------- periods
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); // YYYY-MM-DD
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 86400000);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// The period whose due date is the next one on or after `from` (YYYY-MM-DD), plus its label and due date.
function nextPeriod(c: any, from: string): { key: string; due: string; label: string } {
  const [y, m] = from.split("-").map(Number); const dd = Math.min(28, Math.max(1, Number(c.due_day) || 1));
  if (c.frequency === "annual") { const dm = Math.min(12, Math.max(1, Number(c.due_month) || 1)); let yy = y; let due = `${yy}-${pad(dm)}-${pad(dd)}`; if (due < from) { yy++; due = `${yy}-${pad(dm)}-${pad(dd)}`; } return { key: String(yy), due, label: `${yy} annual dues` }; }
  let yy = y, mm = m; let due = `${yy}-${pad(mm)}-${pad(dd)}`; if (due < from) { mm++; if (mm > 12) { mm = 1; yy++; } due = `${yy}-${pad(mm)}-${pad(dd)}`; }
  return { key: `${yy}-${pad(mm)}`, due, label: `${MONTHS[mm - 1]} ${yy} dues` };
}
function periodFromKey(c: any, key: string): { key: string; due: string; label: string } | null {
  const dd = Math.min(28, Math.max(1, Number(c.due_day) || 1));
  if (/^\d{4}$/.test(key)) { const dm = Math.min(12, Math.max(1, Number(c.due_month) || 1)); return { key, due: `${key}-${pad(dm)}-${pad(dd)}`, label: `${key} annual dues` }; }
  const m = key.match(/^(\d{4})-(\d{2})$/); if (!m) return null; return { key, due: `${key}-${pad(dd)}`, label: `${MONTHS[Number(m[2]) - 1]} ${m[1]} dues` };
}

// ---------------------------------------------------------------- invoices
async function loadCommunity(id: string, accountId?: string) { let q = supabase.from("communities").select("*").eq("id", id); if (accountId) q = q.eq("account_id", accountId); const { data } = await q.maybeSingle(); return data as any; }
async function acctTz(accountId: string): Promise<string> { const { data } = await supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle(); return (data as any)?.settings?.timezone || "America/Chicago"; }

// Create (if missing) and send this period's invoice for every active unit. Idempotent: unique (unit_id, period_key).
async function generatePeriod(c: any, per: { key: string; due: string; label: string }, actorUserId: string, send = true): Promise<{ created: number; sent: number; skipped: number; errors: string[] }> {
  const out = { created: 0, sent: 0, skipped: 0, errors: [] as string[] };
  const { data: units } = await supabase.from("units").select("*").eq("community_id", c.id).eq("is_active", true);
  const { data: have } = await supabase.from("invoices").select("unit_id").eq("community_id", c.id).eq("period_key", per.key).neq("status", "void");
  const done = new Set((have || []).map((r: any) => r.unit_id));
  for (const u of units || []) {
    if (done.has(u.id)) { out.skipped++; continue; }
    const amount = Number(u.dues_cents ?? c.dues_cents) || 0; if (amount <= 0) { out.skipped++; continue; }
    const { data: num } = await supabase.rpc("next_invoice_number", { p_account: c.account_id });
    const row: any = {
      account_id: c.account_id, number: num || `DUES-${Date.now().toString().slice(-6)}`, status: "draft", kind: "dues",
      lines: [{ desc: `${c.name} — ${per.label}`, qty: 1, unit_cents: amount, cents: amount, kind: "service" }],
      customer_name: u.owner_name || null, customer_phone: u.owner_phone || null, customer_email: u.owner_email || null, contact_id: u.contact_id || null,
      service_address: u.label, community_id: c.id, unit_id: u.id, due_at: per.due, period_key: per.key, created_by: actorUserId || null,
      notes: `Dues for ${u.label}. Due ${per.due}.${Number(c.grace_days) > 0 ? ` A ${Number(c.late_fee_cents) > 0 ? money(c.late_fee_cents) + " " : ""}late fee applies after ${c.grace_days} days.` : ""}`,
    };
    const { data: inv, error } = await supabase.from("invoices").insert(row).select("*").maybeSingle();
    if (error || !inv) { if (!/duplicate|unique/i.test(error?.message || "")) out.errors.push(`${u.label}: ${error?.message || "insert failed"}`); else out.skipped++; continue; }
    out.created++;
    if (send && (u.owner_phone || u.owner_email)) { const r = await paymentsApi(actorUserId, { action: "invoice_send", id: inv.id }); if (r?.ok) out.sent++; }
  }
  return out;
}

async function tiles(c: any) {
  const [{ count: units }, { count: autopay }, { data: open }, { data: paidM }, { data: paidY }] = await Promise.all([
    supabase.from("units").select("id", { count: "exact", head: true }).eq("community_id", c.id).eq("is_active", true),
    supabase.from("units").select("id", { count: "exact", head: true }).eq("community_id", c.id).eq("is_active", true).not("autopay", "is", null),
    supabase.from("invoices").select("total_cents, due_at").eq("community_id", c.id).eq("kind", "dues").in("status", ["draft", "sent"]),
    supabase.from("invoices").select("total_cents").eq("community_id", c.id).eq("kind", "dues").eq("status", "paid").gte("paid_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
    supabase.from("invoices").select("total_cents").eq("community_id", c.id).eq("kind", "dues").eq("status", "paid").gte("paid_at", new Date(new Date().getFullYear(), 0, 1).toISOString()),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  return { units: units || 0, autopay: autopay || 0, open_count: (open || []).length, open_cents: (open || []).reduce((s: number, i: any) => s + (i.total_cents || 0), 0), late_count: (open || []).filter((i: any) => i.due_at && i.due_at < today).length, collected_month_cents: (paidM || []).reduce((s: number, i: any) => s + (i.total_cents || 0), 0), collected_year_cents: (paidY || []).reduce((s: number, i: any) => s + (i.total_cents || 0), 0), next: nextPeriod(c, today) };
}

// Pasted roster -> units. One home per line; fields separated by commas/tabs/pipes. We recognise phone, email and $amount
// anywhere on the line; the first remaining field is the address/lot, the second the owner's name.
function parseRoster(text: string): { label: string; owner_name: string | null; owner_phone: string | null; owner_email: string | null; dues_cents: number | null }[] {
  const rows: any[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (/^(address|lot|unit|home|street)\b/i.test(line) && /owner|name|phone|email/i.test(line)) continue; // header
    let parts = line.split(/\t|\s*\|\s*|\s*,\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      // No separators ("105 Oak Creek Dr Maria Lopez 817-555-0103 maria@x.com $95"): pull the phone, email and amount out first.
      let rest1 = line; const pulled: string[] = [];
      for (const re of [/\S+@\S+\.\S+/, /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, /\$\s*\d{1,5}(?:\.\d{2})?/]) { const m = rest1.match(re); if (m) { pulled.push(m[0]); rest1 = rest1.replace(m[0], " "); } }
      parts = [rest1.replace(/\s+/g, " ").trim(), ...pulled].filter(Boolean);
    }
    let phone: string | null = null, email: string | null = null, dues: number | null = null; const rest: string[] = [];
    for (const p of parts) {
      if (!email && /@/.test(p)) { email = p.toLowerCase(); continue; }
      if (!phone && normPhone(p)) { phone = normPhone(p); continue; }
      if (dues == null && /^\$?\s*\d{1,5}(\.\d{2})?$/.test(p)) { dues = Math.round(parseFloat(p.replace(/[^\d.]/g, "")) * 100); continue; }
      rest.push(p);
    }
    if (!rest.length) continue;
    // "123 Elm St Jane Doe" with no separators: split at the first word after the street suffix
    let label = rest[0], owner = rest[1] || null;
    if (rest.length === 1) { const m = label.match(/^(\d+\s+[^,]*?\b(?:st|street|ave|avenue|dr|drive|ln|lane|ct|court|rd|road|way|blvd|cir|circle|pl|place|trl|trail|pkwy|loop|unit\s*\w+|#\s*\w+|lot\s*\d+)\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’-]+)+)$/i); if (m) { label = m[1]; owner = m[2]; } }
    rows.push({ label: label.slice(0, 120), owner_name: owner ? owner.slice(0, 120) : null, owner_phone: phone, owner_email: email, dues_cents: dues });
  }
  return rows;
}

// ---------------------------------------------------------------- the daily sweep
async function sweepCommunity(c: any): Promise<any> {
  const tz = await acctTz(c.account_id); const today = todayStr(tz); const actor = (await ownerUserId(c.account_id)) || "";
  const texting = await smsOn(c.account_id);
  const res: any = { community: c.name, generated: null, reminded: 0, autopay: { charged: 0, processing: 0, failed: 0 }, late_fees: 0 };
  // 1. Generate the coming period when it is notify_days_before away.
  const per = nextPeriod(c, today);
  if (daysBetween(today, per.due) <= Number(c.notify_days_before ?? 10)) res.generated = { period: per.key, ...(await generatePeriod(c, per, actor, true)) };
  // Open dues invoices for this community
  const { data: open } = await supabase.from("invoices").select("*, units(id, label, owner_phone, owner_name, autopay)").eq("community_id", c.id).eq("kind", "dues").in("status", ["draft", "sent"]);
  for (const inv of open || []) {
    const u: any = inv.units || {}; const due = inv.due_at as string; if (!due) continue;
    const dLeft = daysBetween(today, due); // >0 upcoming, 0 today, <0 overdue
    const lastRem = inv.last_reminder_at ? daysBetween(inv.last_reminder_at.slice(0, 10), today) : 99;
    const link = payUrl(inv.pay_token);
    // 3. Autopay on the due date (and one retry the next day), then stop.
    if (u.autopay?.payment_method && dLeft <= 0 && (inv.autopay_attempts || 0) < 2 && dLeft >= -Math.max(1, Number(c.grace_days) || 1)) {
      const r = await paymentsApi(actor, { action: "dues_autopay_charge", invoice_id: inv.id });
      if (r?.ok && r.status === "paid") { res.autopay.charged++; continue; }
      if (r?.ok && r.status === "processing") { res.autopay.processing++; continue; }
      res.autopay.failed++;
      if (texting && u.owner_phone && (inv.autopay_attempts || 0) + 1 >= 2) await sendText(c.account_id, u.owner_phone, `${c.name}: autopay for ${u.label} didn't go through (${r?.message ? String(r.message).slice(0, 60) : "declined"}). Pay here or update your bank/card: ${link}`);
      continue;
    }
    if (u.autopay?.payment_method && inv.paid_note && /processing/.test(inv.paid_note)) continue; // bank debit in flight: no nagging
    // 2. Reminders: 3 days before, the day after it's due, then weekly while late.
    let remind = false;
    if (dLeft === 3) remind = true;
    else if (dLeft === -1) remind = true;
    else if (dLeft < -1 && lastRem >= 7) remind = true;
    if (remind && texting && u.owner_phone && lastRem >= 2) {
      const ap = u.autopay?.payment_method ? u.autopay : null;
      const msg = (dLeft > 0 && ap) ? `${c.name}: autopay will draft ${money(inv.total_cents)} for ${u.label} on ${MONTHS[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))} from your ${ap.method === "card" ? "card" : "bank account"}${ap.last4 ? ` ending ${ap.last4}` : ""}. Nothing to do. To pay another way: ${link}`
        : dLeft > 0 ? `${c.name}: a reminder that ${money(inv.total_cents)} in dues for ${u.label} is due ${MONTHS[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))}. Pay by bank (no fee) or card, or set up autopay: ${link}`
        : `${c.name}: dues of ${money(inv.total_cents)} for ${u.label} were due ${MONTHS[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))}${Number(c.late_fee_cents) > 0 && !inv.late_fee_applied_at ? ` — a ${money(c.late_fee_cents)} late fee applies after ${c.grace_days} days` : ""}. Pay here: ${link}`;
      if (await sendText(c.account_id, u.owner_phone, msg)) { res.reminded++; await supabase.from("invoices").update({ last_reminder_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", inv.id); }
    }
    // 4. Late fee once, after the grace period.
    if (Number(c.late_fee_cents) > 0 && !inv.late_fee_applied_at && -dLeft > Number(c.grace_days || 0)) {
      const lines = [...(inv.lines || []), { desc: `Late fee (${c.grace_days} days past due)`, qty: 1, unit_cents: Number(c.late_fee_cents), cents: Number(c.late_fee_cents), kind: "service" }];
      await supabase.from("invoices").update({ lines, late_fee_applied_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", inv.id);
      res.late_fees++;
      if (texting && u.owner_phone) await sendText(c.account_id, u.owner_phone, `${c.name}: a ${money(c.late_fee_cents)} late fee was added to the dues for ${u.label}. New total ${money(inv.total_cents + Number(c.late_fee_cents))}: ${link}`);
    }
  }
  return res;
}


// ---------------------------------------------------------------- Donna on the phone: "what do I owe?" (Retell custom tool hoa_dues)
const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
async function retellSigValid(raw: string, sig: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sig) return false;
  const m = String(sig).match(/v=(\d+),d=(.*)/); if (!m) return false;
  if (Math.abs(Date.now() - Number(m[1])) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw + m[1]));
    const exp = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join(""); const got = (m[2] || "").trim().toLowerCase();
    if (exp.length !== got.length) return false; let d = 0; for (let i = 0; i < exp.length; i++) d |= exp.charCodeAt(i) ^ got.charCodeAt(i); return d === 0;
  } catch { return false; }
}
const sayDate = (d: string) => d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : "";
// Balances are only spoken for homes whose phone on file is the number calling, and the pay link is texted to that same number.
async function duesForCaller(accountId: string, phone: string): Promise<string> {
  const notFound = "I don't see dues on file for the number you're calling from. If the account is under a different phone number, the manager can verify you and send a statement — would you like me to take a message for them?";
  if (!phone) return notFound;
  const { data: units } = await supabase.from("units").select("id, label, autopay, community_id, communities(name)").eq("account_id", accountId).eq("owner_phone", phone).eq("is_active", true);
  if (!units?.length) return notFound;
  const { data: open } = await supabase.from("invoices").select("id, total_cents, due_at, pay_token, unit_id, late_fee_applied_at").in("unit_id", units.map((u: any) => u.id)).eq("kind", "dues").in("status", ["draft", "sent"]).order("due_at");
  const today = new Date().toISOString().slice(0, 10);
  const byId: Record<string, any> = {}; for (const u of units) byId[(u as any).id] = u;
  const items = (open || []).map((i: any) => ({ ...i, unit: byId[i.unit_id] }));
  const anyAuto = units.some((u: any) => u.autopay?.payment_method);
  if (!items.length) return `You're all paid up${units.length === 1 ? ` for ${(units[0] as any).label}` : ""}; nothing is due right now.${anyAuto ? " Autopay is on, so the next dues will be drafted automatically on the due date." : " Your next dues notice will have a link to pay or to turn on autopay."}`;
  const oneHome = new Set(items.map((i: any) => i.unit_id)).size === 1;
  const total = items.reduce((s: number, i: any) => s + (i.total_cents || 0), 0);
  const parts = items.slice(0, 3).map((i: any) => `${money(i.total_cents)}${oneHome ? "" : ` for ${i.unit.label}`} ${i.due_at < today ? `that was due ${sayDate(i.due_at)}${i.late_fee_applied_at ? ", including a late fee" : ""}` : `due ${sayDate(i.due_at)}`}${i.unit.autopay?.payment_method && i.due_at >= today ? ", which autopay will draft on the due date" : ""}`);
  if (oneHome) parts[0] = `For ${items[0].unit.label}, ${parts[0]}`;
  if (items.length > 1) parts[parts.length - 1] += `, so ${money(total)} in all`;
  const comm = (items[0].unit as any).communities?.name || "Your association";
  const sms = `${comm} dues:\n${items.slice(0, 3).map((i: any) => `${i.unit.label}: ${money(i.total_cents)} due ${sayDate(i.due_at)} ${payUrl(i.pay_token)}`).join("\n")}\nPay by bank (no fee) or card. You can turn on autopay on the same page.`;
  const sent = await sendText(accountId, phone, sms);
  return `${oneHome ? "" : "I have "}${parts.join(oneHome ? ", and " : "; and ")}. ${sent ? "I just texted you a link to pay. Paying by bank has no fee, a card adds a small fee, and you can turn on autopay on that same page." : "You can pay with the link on your dues notice, by bank with no fee or by card."} I can't take card or bank numbers over the phone.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const raw = await req.text();
  let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  // Retell tool call (no Authorization header): identify the business by Donna's number, the caller by theirs.
  if (body?.call && !req.headers.get("Authorization") && !req.headers.get("x-cron-secret")) {
    const valid = await retellSigValid(raw, req.headers.get("x-retell-signature")); console.log(`retell-sig dues: ${valid ? "PASS" : "FAIL"}`);
    if (!valid && RETELL_SIG_ENFORCE) return json({ error: "unauthorized" }, 401);
    const call = body.call || {}; const outbound = call.direction === "outbound";
    const donnaNum = outbound ? call.from_number : call.to_number; const callerNum = normPhone(outbound ? call.to_number : call.from_number);
    const { data: asst } = await supabase.from("assistants").select("account_id").eq("twilio_number", donnaNum).maybeSingle();
    if (!(asst as any)?.account_id) return json({ result: "I'm having trouble looking up dues right now. I can take a message for the manager." });
    return json({ result: await duesForCaller((asst as any).account_id, callerNum) });
  }
  const action = String(body.action || "");
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

  // ---- cron ----
  if (action === "sweep") {
    if (!caller.internal) return json({ ok: false, error: "internal_only" }, 403);
    const { data: comms } = await supabase.from("communities").select("*").eq("is_active", true);
    const out: any[] = []; for (const c of comms || []) { try { out.push(await sweepCommunity(c)); } catch (e) { out.push({ community: c.name, error: String((e as any)?.message || e) }); } }
    return json({ ok: true, communities: out.length, results: out });
  }

  // ---- Donna on the phone / text: what does this caller owe? ----
  if (action === "lookup_by_phone") {
    const phone = normPhone(body.phone || ""); if (!phone || !caller.accountId) return json({ ok: true, found: false });
    const { data: units } = await supabase.from("units").select("id, label, owner_name, autopay, community_id, communities(name)").eq("account_id", caller.accountId).eq("owner_phone", phone).eq("is_active", true);
    if (!units?.length) return json({ ok: true, found: false });
    const ids = units.map((u: any) => u.id);
    const { data: open } = await supabase.from("invoices").select("id, number, total_cents, due_at, period_key, pay_token, unit_id, late_fee_applied_at").in("unit_id", ids).eq("kind", "dues").in("status", ["draft", "sent"]).order("due_at");
    return json({ ok: true, found: true, units: units.map((u: any) => ({ id: u.id, label: u.label, community: u.communities?.name, autopay: u.autopay ? { method: u.autopay.method, last4: u.autopay.last4 } : null, open: (open || []).filter((i: any) => i.unit_id === u.id).map((i: any) => ({ id: i.id, number: i.number, amount: money(i.total_cents), total_cents: i.total_cents, due_at: i.due_at, late: !!i.late_fee_applied_at, pay_url: payUrl(i.pay_token) })) })) });
  }

  if (!caller.accountId) return json({ ok: false, error: "no_account" }, 400);
  const admin = caller.internal || isAdmin(caller.role);
  const acctId = caller.accountId;

  if (action === "communities_list") {
    const { data: comms } = await supabase.from("communities").select("*").eq("account_id", acctId).eq("is_active", true).order("name");
    const out = []; for (const c of comms || []) out.push({ ...c, tiles: await tiles(c) });
    return json({ ok: true, communities: out });
  }
  if (action === "community_save") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const c = body.community || {}; const row: any = { account_id: acctId, updated_at: new Date().toISOString() };
    if (c.name !== undefined) row.name = String(c.name).trim().slice(0, 120);
    if (c.address !== undefined) row.address = String(c.address || "").slice(0, 240) || null;
    if (c.frequency !== undefined) row.frequency = c.frequency === "annual" ? "annual" : "monthly";
    for (const k of ["due_day", "due_month", "dues_cents", "grace_days", "late_fee_cents", "notify_days_before", "payout_day"]) if (c[k] !== undefined) row[k] = Math.max(0, Math.round(Number(c[k]) || 0));
    if (row.due_day !== undefined) row.due_day = Math.min(28, Math.max(1, row.due_day)); if (row.due_month !== undefined) row.due_month = Math.min(12, Math.max(1, row.due_month)); if (row.payout_day !== undefined) row.payout_day = Math.min(28, Math.max(1, row.payout_day));
    if (c.card_fee_pct !== undefined) row.card_fee_pct = Math.min(5, Math.max(0, Number(c.card_fee_pct) || 0));
    if (c.payout_schedule !== undefined) row.payout_schedule = ["daily", "weekly", "monthly"].includes(c.payout_schedule) ? c.payout_schedule : "monthly";
    if (c.settings !== undefined && typeof c.settings === "object") row.settings = c.settings;
    if (!c.id && !row.name) return json({ ok: false, error: "need_name" }, 400);
    let data: any;
    if (c.id) { const r = await supabase.from("communities").update(row).eq("id", c.id).eq("account_id", acctId).select("*").maybeSingle(); data = r.data; if (r.error) return json({ ok: false, error: r.error.message }, 400); }
    else { const r = await supabase.from("communities").insert(row).select("*").maybeSingle(); data = r.data; if (r.error) return json({ ok: false, error: r.error.message }, 400); }
    // Payout schedule lives on the community's Stripe account too (best effort; the PM also has the full Stripe dashboard).
    if (data?.stripe_account_id && (c.payout_schedule !== undefined || c.payout_day !== undefined)) { try { const f: Record<string, string> = { "settings[payouts][schedule][interval]": data.payout_schedule }; if (data.payout_schedule === "monthly") f["settings[payouts][schedule][monthly_anchor]"] = String(data.payout_day || 10); if (data.payout_schedule === "weekly") f["settings[payouts][schedule][weekly_anchor]"] = "friday"; await stripeV1Form(`/v1/accounts/${data.stripe_account_id}`, f); } catch (e) { console.error("payout schedule", String(e)); } }
    return json({ ok: true, community: data });
  }
  if (action === "community_remove") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    await supabase.from("communities").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", String(body.id || "")).eq("account_id", acctId); return json({ ok: true });
  }
  if (action === "community_connect") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const c = await loadCommunity(String(body.id || ""), acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    try {
      let sid = c.stripe_account_id;
      if (!sid) {
        const { data: owner } = await supabase.from("users").select("email").eq("id", caller.userId).maybeSingle();
        // The association is the merchant of record: its own Stripe account, full dashboard, its own bank for payouts. Card + ACH debit.
        const created: any = await stripeV2("POST", "/v2/core/accounts", {
          display_name: c.name, contact_email: (owner as any)?.email || undefined, dashboard: "full",
          defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" }, locales: ["en-US"] },
          identity: { country: "us" },
          configuration: { merchant: { capabilities: { card_payments: { requested: true }, ach_debit_payments: { requested: true } } } },
          metadata: { donna_account_id: acctId, donna_community_id: c.id },
          include: ["configuration.merchant", "requirements"],
        });
        sid = created.id; await supabase.from("communities").update({ stripe_account_id: sid, stripe_status: "onboarding", updated_at: new Date().toISOString() }).eq("id", c.id);
        try { const f: Record<string, string> = { "settings[payouts][schedule][interval]": c.payout_schedule || "monthly" }; if ((c.payout_schedule || "monthly") === "monthly") f["settings[payouts][schedule][monthly_anchor]"] = String(c.payout_day || 10); await stripeV1Form(`/v1/accounts/${sid}`, f); } catch (e) { console.error("payout schedule", String(e)); }
      }
      const link: any = await stripeV2("POST", "/v2/core/account_links", { account: sid, use_case: { type: "account_onboarding", account_onboarding: { refresh_url: `${APP}/?dues=refresh&community=${c.id}`, return_url: `${APP}/?dues=return&community=${c.id}`, collection_options: { fields: "currently_due" } } } });
      return json({ ok: true, url: link.url });
    } catch (e) { console.error("community_connect", e); return json({ ok: false, error: "stripe_error", message: "Stripe didn't accept that just now. Try again in a minute.", detail: String((e as any)?.message || e) }, 502); }
  }
  if (action === "community_refresh") {
    const c = await loadCommunity(String(body.id || ""), acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    if (!c.stripe_account_id) return json({ ok: true, community: c });
    try {
      const a: any = await stripeV2("GET", `/v2/core/accounts/${c.stripe_account_id}?include=configuration.merchant&include=requirements`);
      const cardStatus = a?.configuration?.merchant?.capabilities?.card_payments?.status || ""; const achStatus = a?.configuration?.merchant?.capabilities?.ach_debit_payments?.status || "";
      const charges = cardStatus === "active"; const entries: any[] = Array.isArray(a?.requirements?.entries) ? a.requirements.entries : []; const pastDue = entries.some((e: any) => e?.minimum_deadline?.status === "past_due");
      const upd = { charges_enabled: charges, stripe_status: charges ? "active" : (pastDue ? "restricted" : "onboarding"), requirements: { summary: a?.requirements?.summary || null, count: entries.length, card_payments: cardStatus, ach_debit_payments: achStatus }, updated_at: new Date().toISOString() };
      const { data } = await supabase.from("communities").update(upd).eq("id", c.id).select("*").maybeSingle();
      return json({ ok: true, community: data || { ...c, ...upd } });
    } catch (e) { return json({ ok: false, error: "stripe_error", detail: String((e as any)?.message || e) }, 502); }
  }

  // ---- units ----
  if (action === "units_list") {
    const cid = String(body.community_id || ""); const { data: units } = await supabase.from("units").select("*").eq("account_id", acctId).eq("community_id", cid).eq("is_active", true).order("label");
    const { data: open } = await supabase.from("invoices").select("unit_id, total_cents, due_at, late_fee_applied_at").eq("community_id", cid).eq("kind", "dues").in("status", ["draft", "sent"]);
    const today = new Date().toISOString().slice(0, 10);
    return json({ ok: true, units: (units || []).map((u: any) => { const mine = (open || []).filter((i: any) => i.unit_id === u.id); return { ...u, open_cents: mine.reduce((s: number, i: any) => s + i.total_cents, 0), open_count: mine.length, late: mine.some((i: any) => i.due_at < today) }; }) });
  }
  if (action === "unit_save") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const u = body.unit || {}; const row: any = { account_id: acctId, updated_at: new Date().toISOString() };
    if (u.community_id) row.community_id = u.community_id;
    if (u.label !== undefined) row.label = String(u.label).trim().slice(0, 120);
    if (u.owner_name !== undefined) row.owner_name = String(u.owner_name || "").slice(0, 120) || null;
    if (u.owner_phone !== undefined) row.owner_phone = normPhone(u.owner_phone) || null;
    if (u.owner_email !== undefined) row.owner_email = String(u.owner_email || "").trim().toLowerCase() || null;
    if (u.dues_cents !== undefined) row.dues_cents = u.dues_cents === null || u.dues_cents === "" ? null : Math.max(0, Math.round(Number(u.dues_cents) || 0));
    if (u.notes !== undefined) row.notes = String(u.notes || "").slice(0, 500) || null;
    // Link to a contact by phone so Donna knows the caller on the phone.
    if (row.owner_phone) { const { data: ct } = await supabase.from("contacts").select("id").eq("account_id", acctId).eq("phone", row.owner_phone).limit(1).maybeSingle(); if (ct?.id) row.contact_id = ct.id; else if (row.owner_name) { const { data: nc } = await supabase.from("contacts").insert({ account_id: acctId, name: row.owner_name, phone: row.owner_phone, email: row.owner_email || null, source: "dues" }).select("id").maybeSingle(); if (nc?.id) row.contact_id = nc.id; } }
    let data: any;
    if (u.id) { const r = await supabase.from("units").update(row).eq("id", u.id).eq("account_id", acctId).select("*").maybeSingle(); if (r.error) return json({ ok: false, error: r.error.message }, 400); data = r.data; }
    else { if (!row.community_id || !row.label) return json({ ok: false, error: "need_label" }, 400); const r = await supabase.from("units").insert(row).select("*").maybeSingle(); if (r.error) return json({ ok: false, error: r.error.message }, 400); data = r.data; }
    return json({ ok: true, unit: data });
  }
  if (action === "unit_remove") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    await supabase.from("units").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", String(body.id || "")).eq("account_id", acctId); return json({ ok: true });
  }
  if (action === "units_import") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const cid = String(body.community_id || ""); const c = await loadCommunity(cid, acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    const rows = parseRoster(body.text || ""); if (body.preview) return json({ ok: true, rows });
    const { data: existing } = await supabase.from("units").select("id, label").eq("community_id", cid);
    const byLabel = new Map((existing || []).map((u: any) => [String(u.label).toLowerCase().replace(/\s+/g, " "), u.id]));
    let added = 0, updated = 0;
    for (const r of rows) {
      const key = r.label.toLowerCase().replace(/\s+/g, " "); const row: any = { account_id: acctId, community_id: cid, label: r.label, owner_name: r.owner_name, owner_phone: r.owner_phone, owner_email: r.owner_email, dues_cents: r.dues_cents, is_active: true, updated_at: new Date().toISOString() };
      if (row.owner_phone) { const { data: ct } = await supabase.from("contacts").select("id").eq("account_id", acctId).eq("phone", row.owner_phone).limit(1).maybeSingle(); if (ct?.id) row.contact_id = ct.id; }
      if (byLabel.has(key)) { const upd: any = {}; for (const k of ["owner_name", "owner_phone", "owner_email", "dues_cents", "contact_id"]) if (row[k] != null) upd[k] = row[k]; upd.is_active = true; upd.updated_at = row.updated_at; await supabase.from("units").update(upd).eq("id", byLabel.get(key)); updated++; }
      else { const { error } = await supabase.from("units").insert(row); if (!error) added++; }
    }
    return json({ ok: true, added, updated, parsed: rows.length });
  }

  // ---- billing ----
  if (action === "run") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const c = await loadCommunity(String(body.community_id || ""), acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    const tz = await acctTz(acctId); const per = body.period ? periodFromKey(c, String(body.period)) : nextPeriod(c, todayStr(tz)); if (!per) return json({ ok: false, error: "bad_period" }, 400);
    const actor = caller.userId || (await ownerUserId(acctId)) || "";
    const r = await generatePeriod(c, per, actor, body.send !== false);
    return json({ ok: true, period: per, ...r });
  }
  if (action === "assessment") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const c = await loadCommunity(String(body.community_id || ""), acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    const amount = Math.round(Number(body.amount_cents) || 0); const desc = String(body.desc || "Special assessment").slice(0, 140); const due = String(body.due_at || "").slice(0, 10);
    if (amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json({ ok: false, error: "need_amount_and_due" }, 400);
    let q = supabase.from("units").select("*").eq("community_id", c.id).eq("is_active", true); if (Array.isArray(body.unit_ids) && body.unit_ids.length) q = q.in("id", body.unit_ids);
    const { data: units } = await q; const key = `A-${crypto.randomUUID().slice(0, 8)}`; const actor = caller.userId || (await ownerUserId(acctId)) || ""; let created = 0, sent = 0;
    for (const u of units || []) {
      const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acctId });
      const { data: inv } = await supabase.from("invoices").insert({ account_id: acctId, number: num || `ASMT-${Date.now().toString().slice(-6)}`, status: "draft", kind: "dues", lines: [{ desc: `${c.name} — ${desc}`, qty: 1, unit_cents: amount, cents: amount, kind: "service" }], customer_name: u.owner_name, customer_phone: u.owner_phone, customer_email: u.owner_email, contact_id: u.contact_id, service_address: u.label, community_id: c.id, unit_id: u.id, due_at: due, period_key: key, created_by: actor || null, notes: `Special assessment for ${u.label}. Due ${due}.` }).select("id").maybeSingle();
      if (!inv) continue; created++;
      if (body.send !== false && (u.owner_phone || u.owner_email)) { const r = await paymentsApi(actor, { action: "invoice_send", id: inv.id }); if (r?.ok) sent++; }
    }
    return json({ ok: true, period: key, created, sent });
  }
  if (action === "autopay_link") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const actor = caller.userId || (await ownerUserId(acctId)) || ""; return json(await paymentsApi(actor, { action: "autopay_setup_link", unit_id: body.unit_id, method: body.method, phone: body.phone }));
  }
  if (action === "autopay_cancel") {
    if (!admin) return json({ ok: false, error: "admins_only" }, 403);
    const { data: u } = await supabase.from("units").update({ autopay: null, updated_at: new Date().toISOString() }).eq("id", String(body.unit_id || "")).eq("account_id", acctId).select("label, owner_phone, communities(name)").maybeSingle();
    if (u?.owner_phone && await smsOn(acctId)) await sendText(acctId, u.owner_phone, `${(u as any).communities?.name || "Your community"}: autopay for ${u.label} is off. You'll get a pay link each time dues are due.`);
    return json({ ok: true });
  }

  // ---- reports (computed here, scoped to the caller's account) ----
  if (action === "status") {
    const cid = String(body.community_id || ""); const c = await loadCommunity(cid, acctId); if (!c) return json({ ok: false, error: "not_found" }, 404);
    const tz = await acctTz(acctId); const per = body.period ? periodFromKey(c, String(body.period)) : nextPeriod(c, todayStr(tz));
    const { data: units } = await supabase.from("units").select("id, label, owner_name, owner_phone, owner_email, autopay").eq("community_id", cid).eq("is_active", true).order("label");
    const { data: invs } = await supabase.from("invoices").select("id, unit_id, number, total_cents, due_at, status, paid_at, paid_method, late_fee_applied_at, pay_token").eq("community_id", cid).eq("period_key", per?.key || "").neq("status", "void");
    const byUnit = new Map((invs || []).map((i: any) => [i.unit_id, i]));
    const rows = (units || []).map((u: any) => { const i = byUnit.get(u.id); return { unit_id: u.id, label: u.label, owner_name: u.owner_name, owner_phone: u.owner_phone, owner_email: u.owner_email, autopay: u.autopay ? u.autopay.method : null, invoice: i ? { id: i.id, number: i.number, total_cents: i.total_cents, due_at: i.due_at, status: i.status, paid_at: i.paid_at, paid_method: i.paid_method, late: !!i.late_fee_applied_at, pay_url: payUrl(i.pay_token) } : null }; });
    const paid = rows.filter((r) => r.invoice?.status === "paid").length, open = rows.filter((r) => r.invoice && r.invoice.status !== "paid").length;
    return json({ ok: true, period: per, rows, totals: { units: rows.length, paid, open, not_billed: rows.length - paid - open, collected_cents: rows.reduce((s, r) => s + (r.invoice?.status === "paid" ? r.invoice.total_cents : 0), 0), outstanding_cents: rows.reduce((s, r) => s + (r.invoice && r.invoice.status !== "paid" ? r.invoice.total_cents : 0), 0) } });
  }
  if (action === "delinquent") {
    const cid = String(body.community_id || ""); const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase.from("invoices").select("id, number, total_cents, due_at, period_key, pay_token, late_fee_applied_at, units(id, label, owner_name, owner_phone, autopay)").eq("account_id", acctId).eq("community_id", cid).eq("kind", "dues").in("status", ["draft", "sent"]).lt("due_at", today).order("due_at");
    return json({ ok: true, rows: (data || []).map((i: any) => ({ invoice_id: i.id, number: i.number, total_cents: i.total_cents, due_at: i.due_at, days_late: daysBetween(i.due_at, today), period_key: i.period_key, late_fee: !!i.late_fee_applied_at, pay_url: payUrl(i.pay_token), unit_id: i.units?.id, label: i.units?.label, owner_name: i.units?.owner_name, owner_phone: i.units?.owner_phone, autopay: i.units?.autopay?.method || null })) });
  }
  if (action === "collected") {
    const cid = String(body.community_id || ""); const from = String(body.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()); const to = String(body.to || new Date().toISOString());
    const { data } = await supabase.from("payments").select("received_at, amount_cents, method, provider_ref, invoices!inner(number, period_key, community_id, unit_id, units(label, owner_name))").eq("account_id", acctId).eq("invoices.community_id", cid).gte("received_at", from).lt("received_at", to).order("received_at");
    const rows = (data || []).map((p: any) => ({ paid_at: p.received_at, amount_cents: p.amount_cents, method: p.method, provider_ref: p.provider_ref, number: p.invoices?.number, period_key: p.invoices?.period_key, label: p.invoices?.units?.label, owner_name: p.invoices?.units?.owner_name }));
    return json({ ok: true, from, to, rows, total_cents: rows.reduce((s: number, r: any) => s + (r.amount_cents || 0), 0), by_method: rows.reduce((m: any, r: any) => { m[r.method || "other"] = (m[r.method || "other"] || 0) + (r.amount_cents || 0); return m; }, {}) });
  }
  if (action === "ledger") {
    const uid = String(body.unit_id || ""); const year = Number(body.year) || null;
    let q = supabase.from("invoices").select("id, number, period_key, due_at, total_cents, status, paid_at, paid_method, lines, pay_token").eq("account_id", acctId).eq("unit_id", uid).neq("status", "void").order("due_at");
    if (year) q = q.gte("due_at", `${year}-01-01`).lte("due_at", `${year}-12-31`);
    const { data } = await q; const rows = (data || []).map((i: any) => ({ ...i, pay_url: payUrl(i.pay_token), pay_token: undefined }));
    return json({ ok: true, rows, billed_cents: rows.reduce((s: number, i: any) => s + i.total_cents, 0), paid_cents: rows.filter((i: any) => i.status === "paid").reduce((s: number, i: any) => s + i.total_cents, 0) });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
