import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna: rent collection (v3: keeps the Stripe row current; v2: autopay; v1). PM Donna and Real Estate Donna.
//
// Decisions (Hubert, Nov 11 2026): one Stripe account per management company (payment_accounts, the company is the
// merchant of record; Donna never holds money). Tenants pay by bank (ACH, no fee), card or Cash App (card fee).
// Partial payments are OFF unless the manager turns them on (account-wide, or per lease). A lease can be switched to
// "not accepting payments" (eviction / legal hold): the pay page then refuses money. Late fee once after the grace days.
//
// Signed-in (manager) actions:
//   overview                         -> settings, Stripe status, leases with what is open, totals
//   settings_save {settings}         -> enabled, grace_days, late_fee_cents, late_fee_pct, card_fee_pct, allow_partial, notify_days_before
//   bank_enable                      -> ask Stripe for ACH debit on the company's account, mirror its status
//   tenants                          -> tenants already on file (property_contacts) to start a lease from
//   lease_save {lease} | lease_end {id} | lease_block {id, block, reason?}
//   bill {lease_id, period?}         -> create + send this period's rent now (idempotent per lease + period)
//   charge {lease_id, desc, amount_cents, due_at?} -> one-off charge (repair bill-back, key fee)
//   record {invoice_id, amount_cents?, method, note?} -> money taken by hand (cash, check, Zelle...), full or part
//   remind {invoice_id} | void {invoice_id}
//   ledger {lease_id}                -> every charge and payment for one lease
//   report {from, to}                -> collected and outstanding by property owner
// Public (pay page):
//   checkout {token, method: bank|card, amount_cents?} -> Stripe Checkout URL on the company's account
//   confirm {token}                  -> after returning from Checkout: settle what Stripe says is settled
//   autopay_off {token}              -> tenant turns autopay off from the pay page
// Internal: sweep                    -> bill upcoming rent, remind, late fees, settle checkouts in flight, draw autopay on the due date
//
// Autopay (v2): a tenant ticks "pay my rent automatically" while paying the full balance. Stripe keeps the bank account or
// card (setup_future_usage) and it is stored on the lease. On each due date the sweep draws the rent with an off-session
// PaymentIntent carrying metadata.invoice_id + autopay=1, which the payments webhook already closes (or reports as failed).
// The tenant or the manager can turn it off at any time. Two failed draws on one bill stop autopay for that bill.
//
// A checkout for the whole balance carries metadata.invoice_id, so the existing `payments` webhook marks it paid
// (including bank debits that clear days later). A partial payment carries metadata.rent_invoice_id and is settled here.

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
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (/^\d{10}$/.test(d)) d = "+1" + d; if (/^1\d{10}$/.test(d)) d = "+" + d; return /^\+1\d{10}$/.test(d) ? d : ""; };
const payUrl = (token: string) => `${APP}/pay/${token}`;
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
const nowIso = () => new Date().toISOString();
const HOW: Record<string, string> = { bank: "bank transfer", card: "card", cashapp: "Cash App", cash: "cash", check: "check", zelle: "Zelle", venmo: "Venmo", money_order: "money order", other: "other" };

// ---------------------------------------------------------------- Stripe (raw REST; same secret source as `payments`)
let STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || ""; let keyAt = 0;
async function stripeKey(): Promise<string> { if (STRIPE_KEY) return STRIPE_KEY; if (Date.now() - keyAt < 60_000) return STRIPE_KEY; keyAt = Date.now(); try { const { data } = await supabase.from("app_secrets").select("value").eq("key", "stripe_secret_key").maybeSingle(); STRIPE_KEY = String((data as any)?.value || "").trim(); } catch { /* */ } return STRIPE_KEY; }
const V2_VERSION = "2026-10-28.endive";
async function stripeV2(method: string, path: string, body?: any): Promise<any> {
  const key = await stripeKey(); if (!key) throw new Error("stripe_not_configured");
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Stripe-Version": V2_VERSION, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`stripe_v2 ${method} ${path}: ${j?.error?.message || j?.message || r.status}`); return j;
}
async function stripeV1(method: "GET" | "POST", path: string, form: Record<string, string> | null, stripeAccount: string): Promise<any> {
  const key = await stripeKey(); if (!key) throw new Error("stripe_not_configured");
  const h: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20", "Stripe-Account": stripeAccount };
  if (method === "POST") h["Content-Type"] = "application/x-www-form-urlencoded";
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: h, body: method === "POST" ? new URLSearchParams(form || {}).toString() : undefined });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`stripe ${path}: ${j?.error?.message || r.status}`); return j;
}

// ---------------------------------------------------------------- callers
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
async function loadAccount(id: string) { const { data } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", id).maybeSingle(); return data as any; }
async function loadPA(id: string) { const { data } = await supabase.from("payment_accounts").select("*").eq("account_id", id).maybeSingle(); return data as any; }
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  const num = normPhone(to); if (!num) return false;
  try {
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to: num, body }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.ok) return false;
    try { const { data: cv } = await supabase.from("conversations").upsert({ account_id: accountId, channel: "sms", customer_identifier: num, last_outbound_at: nowIso(), updated_at: nowIso() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle(); if ((cv as any)?.id) await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: (cv as any).id, direction: "outbound", actor: "donna", channel: "sms", body, status: "sent" }); } catch { /* non-fatal */ }
    return true;
  } catch { return false; }
}
async function sendEmail(to: string, business: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: `${business} via Donna <donna@sidekicklogistics.com>`, to: [to], subject, text }) }); return r.ok; } catch { return false; }
}
// Text when texting is on and there is a number, and email when there is an address. True when either got out.
async function tell(acct: any, inv: any, text: string, subject: string): Promise<{ sms: boolean; email: boolean }> {
  const out = { sms: false, email: false };
  if (inv.customer_phone && acct?.settings?.sms?.enabled === true) out.sms = await sendText(acct.id, inv.customer_phone, text);
  if (inv.customer_email) out.email = await sendEmail(inv.customer_email, acct.name, subject, `Hi${inv.customer_name ? " " + inv.customer_name : ""},\n\n${text.replace(/^[^:]+:\s*/, "")}\n\n${acct.name}`);
  return out;
}
async function logActivity(accountId: string, actor: string | null, action: string, entityId: string | null, label: string | null, details: Record<string, unknown> = {}) {
  try { await supabase.rpc("log_activity", { p_account: accountId, p_actor: actor || null, p_action: action, p_entity: "invoice", p_entity_id: entityId, p_label: label, p_details: details }); } catch { /* */ }
}

// ---------------------------------------------------------------- settings
type RentSettings = { enabled: boolean; grace_days: number; late_fee_cents: number; late_fee_pct: number; card_fee_pct: number; allow_partial: boolean; notify_days_before: number; bank_status: string };
function rentSettings(acct: any): RentSettings {
  const r = acct?.settings?.rent || {}; const n = (v: any, d: number, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return { enabled: r.enabled === true, grace_days: Math.round(n(r.grace_days, 5, 0, 30)), late_fee_cents: Math.round(n(r.late_fee_cents, 0, 0, 100000)), late_fee_pct: n(r.late_fee_pct, 0, 0, 20), card_fee_pct: n(r.card_fee_pct, 3, 0, 5), allow_partial: r.allow_partial === true, notify_days_before: Math.round(n(r.notify_days_before, 5, 0, 20)), bank_status: String(r.bank_status || "") };
}
async function saveRentSettings(acct: any, patch: Record<string, unknown>) {
  const settings = { ...(acct.settings || {}), rent: { ...(acct.settings?.rent || {}), ...patch } };
  await supabase.from("accounts").update({ settings }).eq("id", acct.id); acct.settings = settings;
}
// Mirror the company's Stripe capabilities: card (charges on), ACH debit (bank), Cash App. Asks for ACH when `request` is set.
async function refreshStripe(acct: any, pa: any, request = false): Promise<{ charges: boolean; bank: string; cashapp: string }> {
  const out = { charges: !!pa?.charges_enabled, bank: rentSettings(acct).bank_status, cashapp: String(pa?.requirements?.cashapp_payments || "") };
  if (!pa?.stripe_account_id) return out;
  const a: any = await stripeV2("GET", `/v2/core/accounts/${pa.stripe_account_id}?include=configuration.merchant&include=requirements`);
  const caps = a?.configuration?.merchant?.capabilities || {};
  out.charges = caps.card_payments?.status === "active"; out.cashapp = caps.cashapp_payments?.status || out.cashapp;
  let bank = caps.ach_debit_payments?.status || "";
  if (!bank && request) { try { await stripeV2("POST", `/v2/core/accounts/${pa.stripe_account_id}`, { configuration: { merchant: { capabilities: { ach_debit_payments: { requested: true } } } } }); bank = "pending"; } catch (e) { console.error("ach request", String((e as any)?.message || e)); bank = "unavailable"; } }
  out.bank = bank;
  if (bank !== rentSettings(acct).bank_status) await saveRentSettings(acct, { bank_status: bank });
  // Keep the company's Stripe row current here too (the Connect webhook may lag or be missing): status, card and Cash App approval.
  const status = out.charges ? "active" : (pa.status === "restricted" ? "restricted" : "onboarding");
  if (out.charges !== !!pa.charges_enabled || status !== pa.status || (out.cashapp || "") !== String(pa?.requirements?.cashapp_payments || "")) {
    const upd: any = { charges_enabled: out.charges, payouts_enabled: out.charges, status, requirements: { ...(pa.requirements || {}), card_payments: caps.card_payments?.status || "", cashapp_payments: out.cashapp || "" }, last_checked_at: nowIso(), updated_at: nowIso() };
    if (out.charges && !pa.connected_at) upd.connected_at = nowIso();
    await supabase.from("payment_accounts").update(upd).eq("account_id", acct.id);
  }
  return out;
}

// ---------------------------------------------------------------- dates and periods
const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T12:00:00Z").getTime() - new Date(a + "T12:00:00Z").getTime()) / 86400000);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const sayDate = (d: string) => d ? `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8, 10))}` : "";
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const tzOf = (acct: any) => acct?.settings?.timezone || "America/Chicago";
type Period = { key: string; due: string; label: string; rent_cents: number; prorated: boolean };
// What a lease owes for the month `key` (YYYY-MM), or null when nothing is due that month.
function periodFor(l: any, key: string): Period | null {
  const m = key.match(/^(\d{4})-(\d{2})$/); if (!m) return null; const y = Number(m[1]), mo = Number(m[2]);
  const dd = Math.min(28, Math.max(1, Number(l.due_day) || 1)); const start = String(l.start_date || ""); const end = l.end_date ? String(l.end_date) : "";
  const monthStart = `${key}-01`, monthEnd = `${key}-${pad(daysInMonth(y, mo))}`;
  if (!start || start > monthEnd) return null;            // lease has not started
  if (end && end < monthStart) return null;                // lease is over
  let due = `${key}-${pad(dd)}`; let cents = Number(l.rent_cents) || 0; let prorated = false;
  if (start.slice(0, 7) === key && start > due) {          // moved in after this month's due day
    if (l.first_month === "skip") return null;
    due = start;
    if (l.first_month !== "full") { const dim = daysInMonth(y, mo); const days = dim - Number(start.slice(8, 10)) + 1; cents = Math.round(cents * days / dim); prorated = true; }
  }
  if (end && end < due) return null;
  return { key, due, label: `${MONTHS[mo - 1]} ${y} rent`, rent_cents: cents, prorated };
}
const monthKey = (ymd: string, add = 0) => { let y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)) + add; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };

// ---------------------------------------------------------------- invoices
async function ownerUserId(accountId: string): Promise<string | null> { const { data } = await supabase.from("users").select("id").eq("account_id", accountId).eq("role", "owner").order("created_at").limit(1).maybeSingle(); return (data as any)?.id || null; }
async function paidSoFar(invoiceId: string): Promise<number> { const { data } = await supabase.from("payments").select("amount_cents").eq("invoice_id", invoiceId); return (data || []).reduce((s: number, p: any) => s + (Number(p.amount_cents) || 0), 0); }
async function processingCents(invoiceId: string): Promise<{ cents: number; full: boolean }> { const { data } = await supabase.from("rent_sessions").select("amount_cents, partial").eq("invoice_id", invoiceId).eq("status", "processing"); return { cents: (data || []).reduce((s: number, r: any) => s + r.amount_cents, 0), full: (data || []).some((r: any) => !r.partial) }; }
function sendWords(acct: any, s: RentSettings, inv: any, l: any, online: boolean, bank: boolean): string {
  const link = payUrl(inv.pay_token); const how = online ? (bank ? `Pay by bank (no fee)${s.card_fee_pct ? `, or card / Cash App (+${s.card_fee_pct}%)` : ", card or Cash App"}: ${link}` : `Pay by card${s.card_fee_pct ? ` (+${s.card_fee_pct}%)` : ""}: ${link}`) : `Details: ${link}`;
  if (l.autopay?.payment_method && online) return `${acct.name}: rent of ${money(inv.total_cents)} for ${l.label} is due ${sayDate(inv.due_at)}.${autoWords(l)} Details: ${link}`;
  return `${acct.name}: rent of ${money(inv.total_cents)} for ${l.label} is due ${sayDate(inv.due_at)}. ${how}${online ? " You can turn on autopay on the same page." : ""}`;
}
// Create (if missing) the invoice for one lease + period, and send it. Idempotent: unique (lease_id, period_key).
async function billPeriod(acct: any, l: any, per: Period, actor: string | null, send = true): Promise<{ created: boolean; sent: boolean; invoice?: any; error?: string }> {
  const { data: have } = await supabase.from("invoices").select("*").eq("lease_id", l.id).eq("period_key", per.key).neq("status", "void").maybeSingle();
  if (have) return { created: false, sent: false, invoice: have };
  const s = rentSettings(acct);
  const lines: any[] = [{ desc: `${per.label}${per.prorated ? " (prorated from move-in)" : ""}: ${l.label}`, qty: 1, unit_cents: per.rent_cents, cents: per.rent_cents, kind: "service" }];
  for (const x of Array.isArray(l.extras) ? l.extras : []) { const c = Math.round(Number(x?.cents) || 0); if (c > 0 && x?.desc) lines.push({ desc: String(x.desc).slice(0, 80), qty: 1, unit_cents: c, cents: c, kind: "service" }); }
  if (lines.reduce((t, x) => t + x.cents, 0) <= 0) return { created: false, sent: false, error: "nothing_due" };
  const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acct.id });
  const fee = s.late_fee_cents > 0 ? money(s.late_fee_cents) : s.late_fee_pct > 0 ? `${s.late_fee_pct}%` : "";
  const row: any = { account_id: acct.id, number: num || `RENT-${Date.now().toString().slice(-6)}`, status: "draft", kind: "rent", lines,
    customer_name: l.tenant_name, customer_phone: normPhone(l.tenant_phone || "") || null, customer_email: l.tenant_email || null, contact_id: l.contact_id || null,
    service_address: l.label, lease_id: l.id, due_at: per.due, period_key: per.key, created_by: actor || null,
    notes: `Rent for ${l.label}. Due ${per.due}.${fee ? ` A ${fee} late fee applies after ${s.grace_days} days.` : ""}` };
  const { data: inv, error } = await supabase.from("invoices").insert(row).select("*").maybeSingle();
  if (error || !inv) { if (/duplicate|unique/i.test(error?.message || "")) return { created: false, sent: false }; return { created: false, sent: false, error: error?.message || "insert failed" }; }
  let sent = false; if (send && !l.block_payments) sent = await sendInvoice(acct, inv, l);
  return { created: true, sent, invoice: inv };
}
function autoWords(l: any): string { return l.autopay?.payment_method ? ` Autopay will draw it from your ${l.autopay.method === "bank" ? "bank account" : "card"}${l.autopay.last4 ? " ending " + l.autopay.last4 : ""} on that date, so there is nothing to do.` : ""; }
async function sendInvoice(acct: any, inv: any, l: any): Promise<boolean> {
  const s = rentSettings(acct); const pa = await loadPA(acct.id); const online = s.enabled && !!pa?.charges_enabled && !l.block_payments;
  const r = await tell(acct, inv, sendWords(acct, s, inv, l, online, s.bank_status === "active"), `Rent due ${sayDate(inv.due_at)}: ${money(inv.total_cents)}`);
  if (!r.sms && !r.email) return false;
  await supabase.from("invoices").update({ status: "sent", sent_at: nowIso(), sent_channel: r.sms && r.email ? "sms+email" : r.sms ? "sms" : "email", updated_at: nowIso() }).eq("id", inv.id).eq("status", "draft");
  return true;
}
// Record money against a rent invoice. Closes the invoice when the balance reaches zero.
async function applyPayment(acct: any, inv: any, amountCents: number, method: string, provider: string, ref: string | null, note: string | null, feeCents = 0): Promise<{ paid: boolean; balance: number }> {
  const before = await paidSoFar(inv.id);
  await supabase.from("payments").insert({ account_id: inv.account_id, invoice_id: inv.id, amount_cents: amountCents, method: ["bank", "card", "cash", "check", "zelle", "venmo", "other"].includes(method) ? method : "other", provider, provider_ref: ref, fee_cents: null, note: [note, feeCents > 0 ? `plus ${money(feeCents)} card fee` : ""].filter(Boolean).join("; ") || null, tip_cents: 0 });
  const balance = Math.max(0, inv.total_cents - before - amountCents); const link = payUrl(inv.pay_token);
  if (balance <= 0 && !inv.paid_at) {
    await supabase.from("invoices").update({ status: "paid", paid_at: nowIso(), paid_method: before > 0 ? "other" : method, paid_note: before > 0 ? "paid in parts" : note, updated_at: nowIso() }).eq("id", inv.id);
    await tell(acct, inv, `${acct.name}: paid, thank you. ${money(amountCents)} received for rent at ${inv.service_address || "your home"} (${HOW[method] || method}).${before > 0 ? " Your rent is now paid in full." : ""} Your receipt: ${link}`, `Rent receipt: ${money(amountCents)}`);
    return { paid: true, balance: 0 };
  }
  await tell(acct, inv, `${acct.name}: we received ${money(amountCents)} toward rent at ${inv.service_address || "your home"} (${HOW[method] || method}). Still due: ${money(balance)}. ${link}`, `Rent payment received: ${money(amountCents)}`);
  return { paid: false, balance };
}
// Ask Stripe where one checkout stands and settle it. Safe to call any number of times.
// Keep the bank account or card a tenant chose for autopay on their lease. Once per checkout.
async function captureAutopay(rs: any, acct: any, inv: any, pi: any, customer: string | null): Promise<void> {
  const pm = pi?.payment_method && typeof pi.payment_method === "object" ? pi.payment_method : null; if (!pm?.id || !rs.lease_id) return;
  const { data: won } = await supabase.from("rent_sessions").update({ autopay: "saved", updated_at: nowIso() }).eq("id", rs.id).eq("autopay", "want").select("id").maybeSingle(); if (!won) return;
  const bank = pm.type === "us_bank_account"; const last4 = bank ? pm.us_bank_account?.last4 : pm.card?.last4; const brand = bank ? (pm.us_bank_account?.bank_name || "bank account") : (pm.card?.brand || "card");
  await supabase.from("leases").update({ autopay: { customer: customer || pi.customer || null, payment_method: pm.id, method: bank ? "bank" : "card", last4: last4 || null, brand, enrolled_at: nowIso() }, updated_at: nowIso() }).eq("id", rs.lease_id);
  await tell(acct, inv, `${acct.name}: autopay is on for ${inv.service_address || "your home"} using your ${bank ? "bank account" : "card"}${last4 ? " ending " + last4 : ""}. Rent is drawn on each due date and you get a receipt every time. Turn it off any time from your rent link.`, "Autopay is on");
}
async function settleSession(rs: any, acct?: any, pa?: any): Promise<string> {
  const wantsAuto = rs.autopay === "want";
  if (!["open", "processing"].includes(rs.status) && !wantsAuto) return rs.status;
  acct = acct || await loadAccount(rs.account_id); pa = pa || await loadPA(rs.account_id); if (!pa?.stripe_account_id) return rs.status;
  const { data: inv } = await supabase.from("invoices").select("*").eq("id", rs.invoice_id).maybeSingle(); if (!inv) return rs.status;
  // Whole-balance payments are closed by the payments webhook; here we only mirror that.
  if (!rs.partial && inv.paid_at && !wantsAuto) { await supabase.from("rent_sessions").update({ status: "paid", updated_at: nowIso() }).eq("id", rs.id); return "paid"; }
  const isDraw = String(rs.id).startsWith("pi_");   // an autopay draw (no Checkout session)
  let cs: any;
  try {
    if (isDraw) { const p: any = await stripeV1("GET", `/v1/payment_intents/${rs.id}`, null, pa.stripe_account_id); cs = { payment_intent: p, payment_status: p.status === "succeeded" ? "paid" : "unpaid", status: ["succeeded", "processing", "requires_payment_method", "canceled"].includes(p.status) ? "complete" : "open" }; }
    else cs = await stripeV1("GET", `/v1/checkout/sessions/${rs.id}?expand[]=payment_intent.payment_method`, null, pa.stripe_account_id);
  } catch (e) { console.error("settle", String(e)); return rs.status; }
  const pi: any = cs.payment_intent && typeof cs.payment_intent === "object" ? cs.payment_intent : null; const piId = pi?.id || (typeof cs.payment_intent === "string" ? cs.payment_intent : null);
  if (wantsAuto && cs.status === "complete" && pi && !["requires_payment_method", "canceled"].includes(pi.status)) await captureAutopay(rs, acct, inv, pi, typeof cs.customer === "string" ? cs.customer : cs.customer?.id || null);
  if (!["open", "processing"].includes(rs.status)) return rs.status;
  if (!rs.partial && inv.paid_at) { await supabase.from("rent_sessions").update({ status: "paid", updated_at: nowIso() }).eq("id", rs.id); return "paid"; }
  let next = rs.status;
  if (cs.payment_status === "paid") next = "paid";
  else if (cs.status === "expired") next = "expired";
  else if (cs.status === "complete" && pi && ["requires_payment_method", "canceled"].includes(pi.status)) next = "failed";
  else if (cs.status === "complete") next = "processing";
  else if (cs.status === "open" && Date.now() - new Date(rs.created_at).getTime() > 26 * 3600 * 1000) next = "expired";
  if (next === rs.status) return next;
  // Whole-balance payment that Stripe says is paid: give the payments webhook ten minutes to close the invoice before doing it here.
  if (next === "paid" && !rs.partial && !inv.paid_at && Date.now() - new Date(rs.created_at).getTime() < 10 * 60 * 1000) return "paid";
  // Claim the transition so two callers never both apply the money.
  const { data: won } = await supabase.from("rent_sessions").update({ status: next, payment_intent: piId, updated_at: nowIso() }).eq("id", rs.id).eq("status", rs.status).select("id").maybeSingle();
  if (!won) return next;
  if (next === "paid" && rs.partial) await applyPayment(acct, inv, rs.amount_cents, rs.method, "stripe", piId || rs.id, "partial rent payment", rs.fee_cents);
  if (next === "paid" && !rs.partial && !inv.paid_at) {
    // Webhook has not landed (or is not configured): close it here so the tenant is never left showing unpaid.
    const { data: fresh } = await supabase.from("invoices").select("*").eq("id", inv.id).maybeSingle();
    if (fresh && !fresh.paid_at) await applyPayment(acct, fresh, rs.amount_cents, rs.method, "stripe", piId || rs.id, null, rs.fee_cents);
  }
  if (next === "failed" && isDraw) await supabase.from("invoices").update({ paid_note: "autopay failed", updated_at: nowIso() }).eq("id", inv.id);
  if (next === "failed") await tell(acct, inv, `${acct.name}: your ${isDraw ? "autopay " : ""}${HOW[rs.method] || "bank"} payment of ${money(rs.amount_cents)} for rent at ${inv.service_address || "your home"} did not go through. You can try again here: ${payUrl(inv.pay_token)}`, "Your rent payment did not go through");
  return next;
}

// Draw one rent bill from the tenant's saved bank account or card. The payments webhook closes the bill when the money lands.
async function drawAutopay(acct: any, pa: any, l: any, inv: any, s: RentSettings): Promise<string> {
  const ap = l.autopay; if (!ap?.payment_method || !pa?.stripe_account_id || !pa?.charges_enabled) return "skipped";
  const paid = await paidSoFar(inv.id); const amount = inv.total_cents - paid; if (amount <= 0) return "skipped";
  const bank = ap.method === "bank"; const fee = bank || s.card_fee_pct <= 0 ? 0 : Math.round(amount * s.card_fee_pct / 100);
  await supabase.from("invoices").update({ autopay_attempts: (inv.autopay_attempts || 0) + 1, updated_at: nowIso() }).eq("id", inv.id);
  const f: Record<string, string> = { amount: String(amount + fee), currency: inv.currency || "usd", payment_method: ap.payment_method, "payment_method_types[0]": bank ? "us_bank_account" : "card", off_session: "true", confirm: "true",
    description: `${acct.name} · Rent: ${l.label}${inv.period_key ? ` (${inv.period_key})` : ""} (autopay)`.slice(0, 200), "metadata[invoice_id]": inv.id, "metadata[autopay]": "1", "metadata[lease_id]": l.id, "metadata[account_id]": inv.account_id, "metadata[card_fee_cents]": String(fee) };
  if (ap.customer) f.customer = ap.customer;
  try {
    const key = await stripeKey(); const r = await fetch("https://api.stripe.com/v1/payment_intents", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20", "Stripe-Account": pa.stripe_account_id, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `rent-auto-${inv.id}-${(inv.autopay_attempts || 0) + 1}` }, body: new URLSearchParams(f).toString() });
    const pi: any = await r.json().catch(() => ({}));
    if (!r.ok || !pi?.id) throw new Error(pi?.error?.message || `stripe ${r.status}`);
    const st = pi.status === "succeeded" || pi.status === "processing" ? "processing" : "failed";
    await supabase.from("rent_sessions").insert({ id: pi.id, account_id: inv.account_id, invoice_id: inv.id, lease_id: l.id, amount_cents: amount, fee_cents: fee, method: bank ? "bank" : "card", partial: false, status: st, payment_intent: pi.id });
    if (st === "failed") throw new Error(pi.last_payment_error?.message || "declined");
    return pi.status;
  } catch (e) {
    const msg = String((e as any)?.message || e).slice(0, 140);
    await supabase.from("invoices").update({ paid_note: `autopay failed: ${msg}`, updated_at: nowIso() }).eq("id", inv.id);
    await tell(acct, inv, `${acct.name}: we could not draw your rent for ${l.label} by autopay (${msg}). Please pay here: ${payUrl(inv.pay_token)}`, "Autopay did not go through");
    return "failed";
  }
}

// ---------------------------------------------------------------- sweep (bill -> remind -> late fee), per account
async function sweepAccount(acct: any): Promise<any> {
  const s = rentSettings(acct); const today = todayStr(tzOf(acct)); const actor = await ownerUserId(acct.id);
  const res: any = { account: acct.name, billed: 0, sent: 0, reminded: 0, late_fees: 0, ended: 0, errors: [] as string[] };
  const { data: leases } = await supabase.from("leases").select("*").eq("account_id", acct.id).eq("status", "active");
  const byId: Record<string, any> = {}; let pa: any = null;
  for (const l of leases || []) {
    byId[l.id] = l;
    for (const key of [monthKey(today), monthKey(today, 1)]) {
      const per = periodFor(l, key); if (!per) continue;
      const away = daysBetween(today, per.due); if (away > s.notify_days_before) continue;      // not time yet
      if (away < -45) continue;                                                                    // never back-bill old months
      // A lease typed into Donna after this month's due day is not billed (and late-fee'd) behind the manager's back; "Bill now" does it on purpose.
      if (per.due < todayStr(tzOf(acct)) && per.due < new Intl.DateTimeFormat("en-CA", { timeZone: tzOf(acct) }).format(new Date(l.created_at)) && per.due !== String(l.start_date)) continue;
      const r = await billPeriod(acct, l, per, actor, true); if (r.created) res.billed++; if (r.sent) res.sent++; if (r.error && r.error !== "nothing_due") res.errors.push(`${l.label}: ${r.error}`);
    }
    if (l.end_date && String(l.end_date) < today) {
      const { count } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("lease_id", l.id).in("status", ["draft", "sent"]);
      if (!count) { await supabase.from("leases").update({ status: "ended", updated_at: nowIso() }).eq("id", l.id); res.ended++; }
    }
  }
  const { data: open } = await supabase.from("invoices").select("*").eq("account_id", acct.id).eq("kind", "rent").in("status", ["draft", "sent"]).not("lease_id", "is", null);
  for (const inv of open || []) {
    const l = byId[inv.lease_id]; if (!l || !inv.due_at) continue;
    if (l.block_payments) continue;                                 // legal hold: no texts, no fees added automatically
    const proc = await processingCents(inv.id); if (proc.cents > 0) continue;   // money in flight: no nagging
    const dLeft = daysBetween(today, inv.due_at); const lastRem = inv.last_reminder_at ? daysBetween(String(inv.last_reminder_at).slice(0, 10), today) : 99;
    const paid = await paidSoFar(inv.id); let total = inv.total_cents; const link = payUrl(inv.pay_token);
    // Autopay: draw on the due date (and once more the next day if the first try failed). Two failures leave the bill to the tenant.
    if (l.autopay?.payment_method && dLeft <= 0 && (inv.autopay_attempts || 0) < 2 && s.enabled) {
      if (!pa) pa = await loadPA(acct.id);
      const r = await drawAutopay(acct, pa, l, inv, s); if (r !== "skipped") { res.autopay = (res.autopay || 0) + 1; continue; }
    }
    if (l.autopay?.payment_method && dLeft > 0) { if (dLeft === 3 && lastRem >= 2) { const r = await tell(acct, inv, `${acct.name}: heads up, ${money(total - paid)} in rent for ${l.label} will be drawn by autopay on ${sayDate(inv.due_at)}. To pay another way or turn autopay off: ${link}`, "Autopay reminder"); if (r.sms || r.email) await supabase.from("invoices").update({ last_reminder_at: nowIso(), updated_at: nowIso() }).eq("id", inv.id); } continue; }
    // Late fee once, after the grace days (flat amount, or a percent of the rent still owed).
    const feeCents = s.late_fee_cents > 0 ? s.late_fee_cents : s.late_fee_pct > 0 ? Math.round((inv.total_cents - paid) * s.late_fee_pct / 100) : 0;
    if (feeCents > 0 && !inv.late_fee_applied_at && -dLeft > s.grace_days) {
      const lines = [...(inv.lines || []), { desc: `Late fee (more than ${s.grace_days} days past due)`, qty: 1, unit_cents: feeCents, cents: feeCents, kind: "service" }];
      const { data: upd } = await supabase.from("invoices").update({ lines, late_fee_applied_at: nowIso(), last_reminder_at: nowIso(), updated_at: nowIso() }).eq("id", inv.id).is("late_fee_applied_at", null).select("total_cents").maybeSingle();
      if (upd) { res.late_fees++; total = (upd as any).total_cents; await tell(acct, inv, `${acct.name}: a ${money(feeCents)} late fee was added to the rent for ${l.label}. Now due: ${money(total - paid)}. ${link}`, "Late fee added to your rent"); }
      continue;
    }
    // Reminders: 2 days before, the day after it is due, then weekly while late.
    const remind = (dLeft === 2 || dLeft === -1 || (dLeft < -1 && lastRem >= 7)) && lastRem >= 2;
    if (remind) {
      const msg = dLeft > 0 ? `${acct.name}: a reminder that ${money(total - paid)} in rent for ${l.label} is due ${sayDate(inv.due_at)}. Pay here: ${link}`
        : `${acct.name}: rent of ${money(total - paid)} for ${l.label} was due ${sayDate(inv.due_at)}${feeCents > 0 && !inv.late_fee_applied_at ? `. A late fee applies after ${s.grace_days} days` : ""}. Pay here: ${link}`;
      const r = await tell(acct, inv, msg, dLeft > 0 ? "Rent reminder" : "Your rent is past due");
      if (r.sms || r.email) { res.reminded++; await supabase.from("invoices").update({ last_reminder_at: nowIso(), updated_at: nowIso() }).eq("id", inv.id); }
    }
  }
  return res;
}

// ---------------------------------------------------------------- views
async function leaseRows(acct: any) {
  const { data: leases } = await supabase.from("leases").select("*").eq("account_id", acct.id).order("status").order("label");
  const { data: invs } = await supabase.from("invoices").select("id, lease_id, number, status, total_cents, due_at, period_key, paid_at, pay_token, late_fee_applied_at").eq("account_id", acct.id).eq("kind", "rent").not("lease_id", "is", null).neq("status", "void").order("due_at", { ascending: false }).limit(2000);
  const openIds = (invs || []).filter((i: any) => !i.paid_at).map((i: any) => i.id);
  const paidBy: Record<string, number> = {}; const procBy: Record<string, number> = {};
  if (openIds.length) {
    const { data: pays } = await supabase.from("payments").select("invoice_id, amount_cents").in("invoice_id", openIds); for (const p of pays || []) paidBy[p.invoice_id] = (paidBy[p.invoice_id] || 0) + p.amount_cents;
    const { data: rs } = await supabase.from("rent_sessions").select("invoice_id, amount_cents").in("invoice_id", openIds).eq("status", "processing"); for (const r of rs || []) procBy[r.invoice_id] = (procBy[r.invoice_id] || 0) + r.amount_cents;
  }
  const today = todayStr(tzOf(acct));
  return (leases || []).map((l: any) => {
    const mine = (invs || []).filter((i: any) => i.lease_id === l.id); const open = mine.filter((i: any) => !i.paid_at);
    const balance = open.reduce((t: number, i: any) => t + i.total_cents - (paidBy[i.id] || 0), 0);
    const late = open.filter((i: any) => i.due_at && i.due_at < today); const lastPaid = mine.find((i: any) => i.paid_at);
    return { ...l, autopay: l.autopay ? { method: l.autopay.method, last4: l.autopay.last4, brand: l.autopay.brand, enrolled_at: l.autopay.enrolled_at } : null, balance_cents: balance, processing_cents: open.reduce((t: number, i: any) => t + (procBy[i.id] || 0), 0), late_count: late.length, days_late: late.length ? Math.max(...late.map((i: any) => daysBetween(i.due_at, today))) : 0,
      open: open.map((i: any) => ({ id: i.id, number: i.number, due_at: i.due_at, period_key: i.period_key, total_cents: i.total_cents, paid_cents: paidBy[i.id] || 0, processing_cents: procBy[i.id] || 0, pay_url: payUrl(i.pay_token), late_fee: !!i.late_fee_applied_at })),
      last_paid_at: lastPaid?.paid_at || null };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "overview");

  // ================================================================ public: the pay page
  if (action === "checkout" || action === "confirm" || action === "autopay_off") {
    const token = String(body.token || "").trim(); if (!token) return json({ ok: false, error: "no_token" }, 400);
    const { data: inv } = await supabase.from("invoices").select("*").eq("pay_token", token).maybeSingle();
    if (!inv || !inv.lease_id) return json({ ok: false, error: "not_found" }, 404);
    const acct = await loadAccount(inv.account_id); const pa = await loadPA(inv.account_id);
    if (action === "autopay_off") {
      const { data: l0 } = await supabase.from("leases").select("id, label, autopay").eq("id", inv.lease_id).maybeSingle();
      if ((l0 as any)?.autopay) { await supabase.from("leases").update({ autopay: null, updated_at: nowIso() }).eq("id", (l0 as any).id); await tell(acct, inv, `${acct.name}: autopay is now off for ${(l0 as any).label}. You will get a pay link each month instead.`, "Autopay turned off"); }
      return json({ ok: true });
    }
    if (action === "confirm") {
      const { data: live } = await supabase.from("rent_sessions").select("*").eq("invoice_id", inv.id).or("status.in.(open,processing),autopay.eq.want").order("created_at", { ascending: false }).limit(5);
      const states: string[] = []; for (const rs of live || []) states.push(await settleSession(rs, acct, pa));
      const { data: fresh } = await supabase.from("invoices").select("paid_at").eq("id", inv.id).maybeSingle();
      return json({ ok: true, paid: !!(fresh as any)?.paid_at || states.includes("paid"), processing: states.includes("processing"), states });
    }
    if (inv.paid_at || inv.status === "paid") return json({ ok: false, error: "already_paid", message: "This rent is already paid. Thank you." });
    if (inv.status === "void") return json({ ok: false, error: "void", message: "This bill was canceled." });
    const { data: l } = await supabase.from("leases").select("*").eq("id", inv.lease_id).maybeSingle();
    if (!l) return json({ ok: false, error: "not_found" }, 404);
    if (l.block_payments) return json({ ok: false, error: "blocked", message: `${acct.name} is not accepting online payments for this home right now. Please call the office.` });
    const s = rentSettings(acct);
    if (!s.enabled || !pa?.charges_enabled || !pa?.stripe_account_id) return json({ ok: false, error: "online_payments_off", message: "Online rent payments are not switched on yet. Please contact the office." });
    const paid = await paidSoFar(inv.id); const proc = await processingCents(inv.id);
    if (proc.full) return json({ ok: false, error: "processing", message: "A bank payment for this rent is already on its way. It usually clears in 3 to 5 business days." });
    const balance = inv.total_cents - paid - proc.cents;
    if (balance <= 0) return json({ ok: false, error: "processing", message: "Your payments for this rent are still clearing. Nothing more is due right now." });
    const partialOk = l.allow_partial === null || l.allow_partial === undefined ? s.allow_partial : l.allow_partial === true;
    let amount = balance;
    if (body.amount_cents !== undefined && body.amount_cents !== null && Number(body.amount_cents) !== balance) {
      if (!partialOk) return json({ ok: false, error: "full_only", message: `Please pay the full amount of ${money(balance)}.` });
      amount = Math.round(Number(body.amount_cents) || 0);
      if (amount < 100 || amount > balance) return json({ ok: false, error: "bad_amount", message: `Enter an amount between $1.00 and ${money(balance)}.` });
    }
    const partial = amount < inv.total_cents - paid || proc.cents > 0;   // anything short of the full remaining balance is settled here, not by the webhook
    const byBank = body.method === "bank";
    if (byBank && s.bank_status !== "active") return json({ ok: false, error: "bank_off", message: "Bank payments are not available yet. Please use a card." });
    const cashOk = !byBank && pa?.requirements?.cashapp_payments === "active";
    const fee = byBank || s.card_fee_pct <= 0 ? 0 : Math.round(amount * s.card_fee_pct / 100);
    const name = `${partial ? "Rent payment" : "Rent"}: ${l.label}${inv.period_key ? ` (${inv.period_key})` : ""}`.slice(0, 120);
    const f: Record<string, string> = {
      mode: "payment", success_url: `${payUrl(token)}?paid=1`, cancel_url: payUrl(token),
      "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": inv.currency || "usd", "line_items[0][price_data][unit_amount]": String(amount), "line_items[0][price_data][product_data][name]": name,
      "metadata[account_id]": inv.account_id, "metadata[lease_id]": l.id, "metadata[number]": inv.number, "metadata[card_fee_cents]": String(fee),
      "payment_intent_data[description]": `${acct.name} · ${name}${fee ? " (incl. card fee)" : ""}`.slice(0, 200), "payment_intent_data[metadata][lease_id]": l.id, "payment_intent_data[metadata][card_fee_cents]": String(fee),
    };
    if (partial) { f["metadata[rent_invoice_id]"] = inv.id; f["metadata[rent_partial]"] = "1"; f["payment_intent_data[metadata][rent_invoice_id]"] = inv.id; }
    else { f["metadata[invoice_id]"] = inv.id; f["payment_intent_data[metadata][invoice_id]"] = inv.id; }
    if (fee > 0) { f["line_items[1][quantity]"] = "1"; f["line_items[1][price_data][currency]"] = inv.currency || "usd"; f["line_items[1][price_data][unit_amount]"] = String(fee); f["line_items[1][price_data][product_data][name]"] = cashOk ? `Card / Cash App processing fee (${s.card_fee_pct}%)` : `Card processing fee (${s.card_fee_pct}%)`; }
    if (byBank) { f["payment_method_types[0]"] = "us_bank_account"; f["payment_method_options[us_bank_account][verification_method]"] = "instant"; f["payment_method_options[us_bank_account][financial_connections][permissions][0]"] = "payment_method"; }
    else { f["payment_method_types[0]"] = "card"; if (cashOk) f["payment_method_types[1]"] = "cashapp"; }
    if (inv.customer_email) f.customer_email = inv.customer_email;
    // Autopay enrollment rides on a full payment: Stripe keeps the bank account or card for the monthly draw.
    const wantAuto = body.autopay === true && !partial;
    if (wantAuto) { f["payment_intent_data[setup_future_usage]"] = "off_session"; f.customer_creation = "always"; f["metadata[rent_autopay]"] = "1"; f["payment_method_types[0]"] = byBank ? "us_bank_account" : "card"; delete f["payment_method_types[1]"]; }
    try {
      const session: any = await stripeV1("POST", "/v1/checkout/sessions", f, pa.stripe_account_id);
      await supabase.from("rent_sessions").insert({ id: session.id, account_id: inv.account_id, invoice_id: inv.id, lease_id: l.id, amount_cents: amount, fee_cents: fee, method: byBank ? "bank" : "card", partial, autopay: wantAuto ? "want" : null });
      if (!partial) await supabase.from("invoices").update({ stripe_checkout_session_id: session.id, updated_at: nowIso() }).eq("id", inv.id);
      return json({ ok: true, url: session.url });
    } catch (e) { console.error("rent checkout", e); return json({ ok: false, error: "stripe_error", message: "We could not start the payment just now. Please try again in a minute.", detail: String((e as any)?.message || e) }, 502); }
  }

  // ================================================================ everything else: signed in, or internal
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

  if (action === "sweep") {
    if (!caller.internal) return json({ ok: false, error: "internal_only" }, 403);
    const out: any = { ok: true, accounts: [], settled: 0 };
    // 1. Settle checkouts still in flight (returns nobody came back from, bank debits clearing).
    const { data: live } = await supabase.from("rent_sessions").select("*").or("status.in.(open,processing),autopay.eq.want").gte("created_at", new Date(Date.now() - 15 * 86400000).toISOString()).order("created_at").limit(200);
    for (const rs of live || []) { if (body.account_id && rs.account_id !== body.account_id) continue; const before = rs.status; const after = await settleSession(rs); if (after !== before) out.settled++; }
    // 2. Billing, reminders and late fees: once a day per account (or on demand with force).
    const { data: accts } = body.account_id ? await supabase.from("accounts").select("id, name, industry, settings").eq("id", body.account_id) : await supabase.from("accounts").select("id, name, industry, settings").not("settings->rent", "is", null);
    for (const a of accts || []) {
      const s = rentSettings(a); if (!s.enabled) continue;
      const today = todayStr(tzOf(a)); const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tzOf(a), hour: "numeric", hour12: false }).format(new Date()));
      if (!body.force && (a.settings?.rent?.last_sweep === today || hour < 9)) continue;     // texts go out after 9am local, once a day
      await saveRentSettings(a, { last_sweep: today });
      try { out.accounts.push(await sweepAccount(a)); } catch (e) { out.accounts.push({ account: a.name, error: String((e as any)?.message || e) }); }
    }
    return json(out);
  }

  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const admin = isAdmin(caller.role); const s = rentSettings(acct);
  const adminOnly = () => json({ ok: false, error: "admins_only", message: "Only an owner or manager can do that." }, 403);
  const loadLease = async (id: string) => { const { data } = await supabase.from("leases").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle(); return data as any; };
  const loadInv = async (id: string) => { const { data } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).eq("kind", "rent").maybeSingle(); return data as any; };

  if (action === "overview") {
    let pa = await loadPA(acct.id); let stripe = { charges: !!pa?.charges_enabled, bank: s.bank_status, cashapp: String(pa?.requirements?.cashapp_payments || "") };
    if (pa?.stripe_account_id && body.refresh) { try { stripe = await refreshStripe(acct, pa, false); pa = await loadPA(acct.id); } catch (e) { console.error("refresh", String(e)); } }
    const rows = await leaseRows(acct); const today = todayStr(tzOf(acct)); const from = `${today.slice(0, 7)}-01`;
    const { data: pays } = await supabase.from("payments").select("amount_cents, invoices!inner(kind, lease_id)").eq("account_id", acct.id).eq("invoices.kind", "rent").gte("received_at", from + "T00:00:00Z");
    const active = rows.filter((r: any) => r.status === "active");
    return json({ ok: true, settings: rentSettings(acct), stripe: { connected: !!pa?.stripe_account_id, status: pa?.status || "not_connected", ...stripe }, leases: rows,
      totals: { leases: active.length, monthly_rent_cents: active.reduce((t: number, r: any) => t + r.rent_cents, 0), open_cents: rows.reduce((t: number, r: any) => t + r.balance_cents, 0), late: rows.filter((r: any) => r.late_count > 0).length, processing_cents: rows.reduce((t: number, r: any) => t + r.processing_cents, 0), collected_month_cents: (pays || []).reduce((t: number, p: any) => t + p.amount_cents, 0) } });
  }

  if (action === "settings_save") {
    if (!admin) return adminOnly();
    const inp = body.settings || {}; const patch: Record<string, unknown> = {};
    if (inp.enabled !== undefined) {
      if (inp.enabled === true) { const pa = await loadPA(acct.id); if (!pa?.charges_enabled) return json({ ok: false, error: "not_connected", message: "Connect Stripe first (Settings, Payments). Rent goes straight to your company's own Stripe account." }); }
      patch.enabled = inp.enabled === true;
    }
    for (const k of ["grace_days", "late_fee_cents", "late_fee_pct", "card_fee_pct", "notify_days_before"]) if (inp[k] !== undefined) patch[k] = Number(inp[k]) || 0;
    if (inp.allow_partial !== undefined) patch.allow_partial = inp.allow_partial === true;
    await saveRentSettings(acct, patch);
    if (patch.enabled === true) { try { const pa = await loadPA(acct.id); await refreshStripe(acct, pa, true); } catch (e) { console.error("bank on enable", String(e)); } }
    return json({ ok: true, settings: rentSettings(acct) });
  }

  if (action === "bank_enable") {
    if (!admin) return adminOnly();
    const pa = await loadPA(acct.id); if (!pa?.stripe_account_id) return json({ ok: false, error: "not_connected", message: "Connect Stripe first (Settings, Payments)." });
    try { const st = await refreshStripe(acct, pa, true); return json({ ok: true, stripe: st }); } catch (e) { return json({ ok: false, error: "stripe_error", message: "Stripe did not answer just now. Try again in a minute.", detail: String((e as any)?.message || e) }, 502); }
  }

  if (action === "tenants") {
    const { data } = await supabase.from("property_contacts").select("id, property_id, contact_id, unit, name, phone, email, lease_start, lease_end, rent_due_day, properties(name, address)").eq("account_id", acct.id).eq("role", "tenant").order("name").limit(500);
    const { data: have } = await supabase.from("leases").select("property_contact_id").eq("account_id", acct.id).eq("status", "active").not("property_contact_id", "is", null);
    const taken = new Set((have || []).map((r: any) => r.property_contact_id));
    return json({ ok: true, tenants: (data || []).map((t: any) => ({ id: t.id, property_id: t.property_id, contact_id: t.contact_id, name: t.name, phone: t.phone, email: t.email, unit: t.unit, property: t.properties?.name || "", address: t.properties?.address || "", lease_start: t.lease_start, lease_end: t.lease_end, rent_due_day: t.rent_due_day, has_lease: taken.has(t.id) })) });
  }

  if (action === "lease_save") {
    if (!admin) return adminOnly();
    const i = body.lease || {}; const rent = Math.round(Number(i.rent_cents) || 0);
    const name = String(i.tenant_name || "").trim().slice(0, 120); const label = String(i.label || "").trim().slice(0, 160); const start = String(i.start_date || "").slice(0, 10);
    if (!name) return json({ ok: false, error: "invalid", message: "Add the tenant's name." });
    if (!label) return json({ ok: false, error: "invalid", message: "Add the address or unit they rent." });
    if (rent <= 0) return json({ ok: false, error: "invalid", message: "Add the monthly rent." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return json({ ok: false, error: "invalid", message: "Add the lease start date." });
    const end = /^\d{4}-\d{2}-\d{2}$/.test(String(i.end_date || "")) ? String(i.end_date) : null;
    if (end && end < start) return json({ ok: false, error: "invalid", message: "The end date is before the start date." });
    const phone = i.tenant_phone ? normPhone(String(i.tenant_phone)) : ""; if (i.tenant_phone && !phone) return json({ ok: false, error: "invalid", message: "That phone number does not look right." });
    const extras = (Array.isArray(i.extras) ? i.extras : []).map((x: any) => ({ desc: String(x?.desc || "").trim().slice(0, 80), cents: Math.round(Number(x?.cents) || 0) })).filter((x: any) => x.desc && x.cents > 0).slice(0, 8);
    const row: any = { account_id: acct.id, tenant_name: name, tenant_phone: phone || null, tenant_email: String(i.tenant_email || "").trim().toLowerCase() || null, label, owner_name: String(i.owner_name || "").trim().slice(0, 120) || null,
      rent_cents: rent, due_day: Math.min(28, Math.max(1, Math.round(Number(i.due_day) || 1))), start_date: start, end_date: end, first_month: ["prorate", "full", "skip"].includes(i.first_month) ? i.first_month : "prorate", extras,
      allow_partial: i.allow_partial === true ? true : i.allow_partial === false ? false : null, notes: String(i.notes || "").slice(0, 1000) || null,
      property_id: i.property_id || null, property_contact_id: i.property_contact_id || null, contact_id: i.contact_id || null, updated_at: nowIso() };
    if (i.id) { const cur = await loadLease(String(i.id)); if (!cur) return json({ ok: false, error: "not_found" }, 404); const { data, error } = await supabase.from("leases").update(row).eq("id", cur.id).select("*").maybeSingle(); if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400); return json({ ok: true, lease: data }); }
    const { data, error } = await supabase.from("leases").insert(row).select("*").maybeSingle(); if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400);
    return json({ ok: true, lease: data });
  }

  if (action === "lease_end") {
    if (!admin) return adminOnly(); const l = await loadLease(String(body.id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    const today = todayStr(tzOf(acct));
    const { data } = await supabase.from("leases").update({ status: "ended", end_date: l.end_date && l.end_date < today ? l.end_date : today, updated_at: nowIso() }).eq("id", l.id).select("*").maybeSingle();
    return json({ ok: true, lease: data });
  }

  if (action === "lease_block") {
    if (!admin) return adminOnly(); const l = await loadLease(String(body.id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    const block = body.block === true;
    const { data } = await supabase.from("leases").update({ block_payments: block, block_reason: block ? String(body.reason || "").slice(0, 200) || null : null, updated_at: nowIso() }).eq("id", l.id).select("*").maybeSingle();
    await logActivity(acct.id, caller.userId, block ? "rent.payments_stopped" : "rent.payments_resumed", null, l.label, { tenant: l.tenant_name, reason: body.reason || null });
    return json({ ok: true, lease: data });
  }

  if (action === "lease_autopay_off") {
    if (!admin) return adminOnly(); const l = await loadLease(String(body.id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    await supabase.from("leases").update({ autopay: null, updated_at: nowIso() }).eq("id", l.id);
    await logActivity(acct.id, caller.userId, "rent.autopay_off", null, l.label, { tenant: l.tenant_name });
    return json({ ok: true });
  }

  if (action === "bill") {
    if (!admin) return adminOnly(); const l = await loadLease(String(body.lease_id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    if (l.status !== "active") return json({ ok: false, error: "ended", message: "This lease has ended." });
    const today = todayStr(tzOf(acct)); let key = /^\d{4}-\d{2}$/.test(String(body.period || "")) ? String(body.period) : "";
    if (!key) { key = monthKey(today); const { data: have } = await supabase.from("invoices").select("id").eq("lease_id", l.id).eq("period_key", key).neq("status", "void").maybeSingle(); if (have || !periodFor(l, key)) key = monthKey(today, 1); }
    const per = periodFor(l, key); if (!per) return json({ ok: false, error: "no_period", message: "Nothing is due for that month on this lease (check the start and end dates)." });
    const r = await billPeriod(acct, l, per, caller.userId || null, body.send !== false);
    if (r.error) return json({ ok: false, error: "bill_failed", message: r.error });
    return json({ ok: true, created: r.created, sent: r.sent, period: per.key, invoice: r.invoice ? { id: r.invoice.id, number: r.invoice.number, total_cents: r.invoice.total_cents, due_at: r.invoice.due_at, pay_url: payUrl(r.invoice.pay_token) } : null, message: r.created ? (r.sent ? `${per.label} sent to ${l.tenant_name}.` : `${per.label} created. It was not sent (no phone or email, texting off, or payments stopped).`) : `${per.label} was already billed.` });
  }

  if (action === "charge") {
    if (!admin) return adminOnly(); const l = await loadLease(String(body.lease_id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    const cents = Math.round(Number(body.amount_cents) || 0); const desc = String(body.desc || "").trim().slice(0, 120);
    if (cents <= 0 || !desc) return json({ ok: false, error: "invalid", message: "Add what the charge is for and the amount." });
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_at || "")) ? String(body.due_at) : todayStr(tzOf(acct));
    const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acct.id });
    const { data: inv, error } = await supabase.from("invoices").insert({ account_id: acct.id, number: num || `RENT-${Date.now().toString().slice(-6)}`, status: "draft", kind: "rent", lines: [{ desc: `${desc}: ${l.label}`, qty: 1, unit_cents: cents, cents, kind: "service" }], customer_name: l.tenant_name, customer_phone: normPhone(l.tenant_phone || "") || null, customer_email: l.tenant_email || null, contact_id: l.contact_id || null, service_address: l.label, lease_id: l.id, due_at: due, created_by: caller.userId || null, notes: `${desc} for ${l.label}. Due ${due}.` }).select("*").maybeSingle();
    if (error || !inv) return json({ ok: false, error: "save_failed", message: error?.message || "Could not save the charge." }, 400);
    let sent = false;
    if (body.send !== false && !l.block_payments) { const pa = await loadPA(acct.id); const online = s.enabled && !!pa?.charges_enabled; const r = await tell(acct, inv, `${acct.name}: a charge of ${money(cents)} for ${desc} at ${l.label} is due ${sayDate(due)}. ${online ? "Pay here" : "Details"}: ${payUrl(inv.pay_token)}`, `New charge: ${money(cents)}`); sent = r.sms || r.email; if (sent) await supabase.from("invoices").update({ status: "sent", sent_at: nowIso(), updated_at: nowIso() }).eq("id", inv.id); }
    return json({ ok: true, sent, invoice: { id: inv.id, number: inv.number, total_cents: inv.total_cents, pay_url: payUrl(inv.pay_token) } });
  }

  if (action === "record") {
    if (!admin) return adminOnly(); const inv = await loadInv(String(body.invoice_id || "")); if (!inv) return json({ ok: false, error: "not_found" }, 404);
    if (inv.paid_at) return json({ ok: false, error: "already_paid", message: "That one is already paid." }); if (inv.status === "void") return json({ ok: false, error: "void" });
    const paid = await paidSoFar(inv.id); const balance = inv.total_cents - paid;
    const amount = body.amount_cents === undefined || body.amount_cents === null ? balance : Math.round(Number(body.amount_cents) || 0);
    if (amount <= 0 || amount > balance) return json({ ok: false, error: "bad_amount", message: `Enter an amount between $0.01 and ${money(balance)}.` });
    const method = ["cash", "check", "zelle", "venmo", "bank", "card", "other"].includes(body.method) ? body.method : "other";
    const r = await applyPayment(acct, inv, amount, method, "manual", null, String(body.note || "").slice(0, 200) || (amount < balance ? "partial rent payment" : null));
    await logActivity(acct.id, caller.userId, "invoice.paid", inv.id, inv.number, { method, amount_cents: amount, partial: !r.paid });
    return json({ ok: true, paid: r.paid, balance_cents: r.balance });
  }

  if (action === "remind") {
    if (!admin) return adminOnly(); const inv = await loadInv(String(body.invoice_id || "")); if (!inv) return json({ ok: false, error: "not_found" }, 404);
    if (inv.paid_at) return json({ ok: false, error: "already_paid" }); const l = await loadLease(inv.lease_id); if (!l) return json({ ok: false, error: "not_found" }, 404);
    if (l.block_payments) return json({ ok: false, error: "blocked", message: "Payments are stopped for this tenant, so Donna will not send a pay link." });
    const paid = await paidSoFar(inv.id);
    const r = await tell(acct, inv, `${acct.name}: ${money(inv.total_cents - paid)} in rent for ${l.label} ${inv.due_at && inv.due_at < todayStr(tzOf(acct)) ? "was" : "is"} due ${sayDate(inv.due_at)}. Pay here: ${payUrl(inv.pay_token)}`, "Rent reminder");
    if (!r.sms && !r.email) return json({ ok: false, error: "not_sent", message: "It did not go out. Check the tenant's phone or email, and that texting is on." });
    await supabase.from("invoices").update({ status: inv.status === "draft" ? "sent" : inv.status, sent_at: inv.sent_at || nowIso(), last_reminder_at: nowIso(), updated_at: nowIso() }).eq("id", inv.id);
    return json({ ok: true, sent: r });
  }

  if (action === "void") {
    if (!admin) return adminOnly(); const inv = await loadInv(String(body.invoice_id || "")); if (!inv) return json({ ok: false, error: "not_found" }, 404);
    if (inv.paid_at) return json({ ok: false, error: "already_paid", message: "A paid bill can't be canceled here." });
    if ((await paidSoFar(inv.id)) > 0) return json({ ok: false, error: "has_payments", message: "This bill already has a payment on it, so it can't be canceled." });
    if ((await processingCents(inv.id)).cents > 0) return json({ ok: false, error: "processing", message: "A payment for this bill is still clearing." });
    await supabase.from("invoices").update({ status: "void", updated_at: nowIso() }).eq("id", inv.id);
    await logActivity(acct.id, caller.userId, "invoice.void", inv.id, inv.number, { total_cents: inv.total_cents });
    return json({ ok: true });
  }

  if (action === "ledger") {
    const l = await loadLease(String(body.lease_id || "")); if (!l) return json({ ok: false, error: "not_found" }, 404);
    const { data: invs } = await supabase.from("invoices").select("id, number, status, lines, total_cents, due_at, period_key, paid_at, paid_method, pay_token, late_fee_applied_at, sent_at, created_at").eq("lease_id", l.id).order("due_at", { ascending: false }).limit(200);
    const ids = (invs || []).map((i: any) => i.id);
    const { data: pays } = ids.length ? await supabase.from("payments").select("invoice_id, amount_cents, method, provider, note, received_at").in("invoice_id", ids).order("received_at", { ascending: false }) : { data: [] as any[] };
    const { data: rs } = ids.length ? await supabase.from("rent_sessions").select("invoice_id, amount_cents, method, status, created_at").in("invoice_id", ids).eq("status", "processing") : { data: [] as any[] };
    return json({ ok: true, lease: { ...l, autopay: l.autopay ? { method: l.autopay.method, last4: l.autopay.last4, brand: l.autopay.brand, enrolled_at: l.autopay.enrolled_at } : null }, invoices: (invs || []).map((i: any) => ({ ...i, pay_url: payUrl(i.pay_token), pay_token: undefined, paid_cents: (pays || []).filter((p: any) => p.invoice_id === i.id).reduce((t: number, p: any) => t + p.amount_cents, 0) })), payments: pays || [], processing: rs || [] });
  }

  if (action === "report") {
    const today = todayStr(tzOf(acct)); const from = /^\d{4}-\d{2}-\d{2}$/.test(String(body.from || "")) ? String(body.from) : `${today.slice(0, 7)}-01`; const to = /^\d{4}-\d{2}-\d{2}$/.test(String(body.to || "")) ? String(body.to) : today;
    const { data: leases } = await supabase.from("leases").select("id, label, tenant_name, owner_name, rent_cents, status").eq("account_id", acct.id);
    const { data: invs } = await supabase.from("invoices").select("id, lease_id, total_cents, due_at, paid_at, status").eq("account_id", acct.id).eq("kind", "rent").not("lease_id", "is", null).neq("status", "void").limit(5000);
    const invBy: Record<string, any> = {}; for (const i of invs || []) invBy[i.id] = i;
    const ids = (invs || []).map((i: any) => i.id);
    const pays: any[] = []; for (let k = 0; k < ids.length; k += 300) { const { data } = await supabase.from("payments").select("invoice_id, amount_cents, method, received_at").in("invoice_id", ids.slice(k, k + 300)); pays.push(...(data || [])); }
    const rows = (leases || []).map((l: any) => {
      const mine = (invs || []).filter((i: any) => i.lease_id === l.id); const myPays = pays.filter((p: any) => invBy[p.invoice_id]?.lease_id === l.id);
      const collected = myPays.filter((p: any) => String(p.received_at).slice(0, 10) >= from && String(p.received_at).slice(0, 10) <= to).reduce((t: number, p: any) => t + p.amount_cents, 0);
      const billed = mine.filter((i: any) => i.due_at >= from && i.due_at <= to).reduce((t: number, i: any) => t + i.total_cents, 0);
      const open = mine.filter((i: any) => !i.paid_at).reduce((t: number, i: any) => t + i.total_cents - myPays.filter((p: any) => p.invoice_id === i.id).reduce((x: number, p: any) => x + p.amount_cents, 0), 0);
      return { lease_id: l.id, owner: l.owner_name || "No owner set", label: l.label, tenant: l.tenant_name, status: l.status, billed_cents: billed, collected_cents: collected, open_cents: open };
    }).filter((r: any) => r.status === "active" || r.billed_cents || r.collected_cents || r.open_cents);
    const owners: Record<string, any> = {}; for (const r of rows) { const o = owners[r.owner] || (owners[r.owner] = { owner: r.owner, homes: 0, billed_cents: 0, collected_cents: 0, open_cents: 0 }); o.homes++; o.billed_cents += r.billed_cents; o.collected_cents += r.collected_cents; o.open_cents += r.open_cents; }
    return json({ ok: true, from, to, owners: Object.values(owners).sort((a: any, b: any) => a.owner.localeCompare(b.owner)), rows: rows.sort((a: any, b: any) => a.owner.localeCompare(b.owner) || a.label.localeCompare(b.label)) });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
