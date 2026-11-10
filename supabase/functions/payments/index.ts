import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.25.0?target=denonext";

// Donna shared payments module (v18: salon checkout — tickets with tips, products with stock, gift cards sold/redeemed; v17 activity log). Any vertical can use it; the dashboard exposes it to contractors first.
// Tenants connect THEIR OWN Stripe account (Connect, Accounts v2, SaaS pattern). Donna never holds, touches or routes money:
// Checkout Sessions are created directly on the tenant's account (Stripe-Account header), no application fee.
//
// User actions (JWT, or service role + user_id from internal callers):
//   status | connect | refresh | enable | disable
//   invoice_create | invoice_update | invoice_send | invoice_mark_paid | invoice_void | invoice_list | export_csv
//   card_setup_send {appointment_id|job_id, phone?}  -> texts the customer a Stripe link to put a card on file (nothing charged; saved on the job)
//   invoice_charge_card {id}                          -> charges the card on file for the invoice's job (off-session); falls back to the pay link
// Public actions:       checkout {token}  -> Stripe Checkout URL for one invoice (pay page calls this)
//                       webhook           -> Stripe Connect webhook (signature-verified)
// Secrets: STRIPE_SECRET_KEY (env) decides test vs live; webhook secret from env or app_secrets
//          (stripe_webhook_secret = live endpoint, stripe_webhook_secret_test = sandbox endpoint).

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
// Stripe secrets: env first, then the app_secrets table (keys stripe_secret_key / stripe_webhook_secret). Cached per instance.
let STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
let WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
let stripe: Stripe | null = null; let secretsLoadedAt = 0;
async function ensureStripe(): Promise<Stripe | null> {
  if (stripe && WEBHOOK_SECRET) return stripe;
  if (Date.now() - secretsLoadedAt > 60_000) {
    secretsLoadedAt = Date.now();
    try {
      const { data } = await supabase.from("app_secrets").select("key, value").in("key", ["stripe_secret_key", "stripe_webhook_secret", "stripe_webhook_secret_test"]);
      const m = new Map((data || []).map((r: any) => [r.key, r.value || ""]));
      if (!Deno.env.get("STRIPE_SECRET_KEY") && m.get("stripe_secret_key")) STRIPE_KEY = m.get("stripe_secret_key")!;
      // The key decides the mode; pick the webhook secret that matches (test endpoint vs live endpoint).
      const isTest = STRIPE_KEY.startsWith("sk_test_") || STRIPE_KEY.startsWith("rk_test_");
      const wh = isTest ? (m.get("stripe_webhook_secret_test") || m.get("stripe_webhook_secret")) : m.get("stripe_webhook_secret");
      if (!Deno.env.get("STRIPE_WEBHOOK_SECRET") && wh) WEBHOOK_SECRET = wh;
    } catch { /* keep env */ }
  }
  if (!stripe && STRIPE_KEY) stripe = new Stripe(STRIPE_KEY, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
  return stripe;
}
// Accounts v2 (new Connect platforms must use it). Raw fetch; the v1 SDK is still used for Checkout on the connected account.
const V2_VERSION = "2026-10-28.endive";
async function stripeV2(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": V2_VERSION, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) { const msg = j?.error?.message || j?.message || `${r.status}`; throw new Error(`stripe_v2 ${method} ${path}: ${msg}`); }
  return j;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const payUrl = (token: string) => `${APP}/pay/${token}`;
// Card processing fee (settings.payments.card_fee_pct, 0 = off). Charged only when the customer pays by card; cash/check never pay it.
const cardFee = (acct: any, totalCents: number) => { const pct = Number(acct?.settings?.payments?.card_fee_pct || 0); return pct > 0 ? { pct, cents: Math.round(totalCents * pct / 100) } : { pct: 0, cents: 0 }; };

async function resolveCaller(req: Request, body?: any): Promise<{ userId: string; accountId: string; role: string } | null> {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i);
  if (!m) return null;
  // Internal callers (jobs, text-command layer) use the service role and name the acting user.
  if (m[1] === SERVICE_ROLE && body?.user_id) {
    const { data: me } = await supabase.from("users").select("id, account_id, role").eq("id", body.user_id).maybeSingle();
    return me ? { userId: me.id, accountId: me.account_id, role: me.role } : null;
  }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]);
  if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role").eq("id", user.id).maybeSingle();
  if (!(me as any)?.account_id) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role };
}
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
// A team member may act on an invoice they created or whose job is assigned to them; admins on any.
// v17: audit trail. Owners/managers read activity_log on the Team page.
async function logActivity(accountId: string, actor: string | null, action: string, entity: string, entityId: string | null, label: string | null, details: Record<string, unknown> = {}) {
  try { await supabase.rpc("log_activity", { p_account: accountId, p_actor: actor || null, p_action: action, p_entity: entity, p_entity_id: entityId, p_label: label, p_details: details }); } catch (e) { console.error("log_activity", String(e)); }
}
async function canTouchInvoice(caller: any, inv: any): Promise<boolean> {
  if (isAdmin(caller.role)) return true;
  if (inv.created_by && inv.created_by === caller.userId) return true;
  if (inv.job_id) { const { data: j } = await supabase.from("jobs").select("assigned_user_id").eq("id", inv.job_id).maybeSingle(); if (j?.assigned_user_id === caller.userId) return true; }
  return false;
}

async function loadAccount(accountId: string) {
  const { data } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", accountId).maybeSingle();
  return data as any;
}
async function loadPA(accountId: string) {
  const { data } = await supabase.from("payment_accounts").select("*").eq("account_id", accountId).maybeSingle();
  return data as any;
}
async function setPaymentsEnabled(acct: any, enabled: boolean) {
  const s = { ...(acct.settings || {}) }; s.payments = { ...(s.payments || {}), enabled, provider: "stripe" };
  await supabase.from("accounts").update({ settings: s }).eq("id", acct.id);
}
function normLines(raw: any[]): any[] {
  return (Array.isArray(raw) ? raw : []).map((l: any) => {
    const qty = Math.max(0, Number(l.qty ?? 1) || 1);
    const unit = Math.round(Number(l.unit_cents ?? (l.unit != null ? Number(l.unit) * 100 : 0)) || 0);
    const kind = ["service", "addon", "trip_fee", "discount", "tax", "material", "labor", "product", "gift_card", "gift_card_sale"].includes(l.kind) ? l.kind : "service";
    const neg = kind === "discount" || kind === "gift_card";
    const cents = l.cents != null ? Math.round(Number(l.cents)) : Math.round(qty * unit) * (neg ? -1 : 1);
    const out: any = { desc: String(l.desc || l.name || "").slice(0, 140), qty, unit_cents: unit, cents: neg ? -Math.abs(cents) : cents, kind };
    if (l.product_id) out.product_id = String(l.product_id);
    if (kind === "gift_card" && l.code) out.code = String(l.code).trim().toUpperCase();
    if (kind === "gift_card_sale") { if (l.recipient_name) out.recipient_name = String(l.recipient_name).slice(0, 80); if (l.recipient_phone) out.recipient_phone = String(l.recipient_phone).trim(); }
    return out;
  }).filter((l) => l.desc);
}

// Refresh connected-account capabilities from Stripe and mirror into payment_accounts (+ auto-enable when charges are live).
async function refreshStatus(acct: any, pa: any) {
  if (!STRIPE_KEY || !pa?.stripe_account_id) return pa;
  const a: any = await stripeV2("GET", `/v2/core/accounts/${pa.stripe_account_id}?include=configuration.merchant&include=requirements`);
  const cardStatus = a?.configuration?.merchant?.capabilities?.card_payments?.status || "";
  const charges = cardStatus === "active";
  const reqs = a?.requirements || null;
  const entries: any[] = Array.isArray(reqs?.entries) ? reqs.entries : [];
  const pastDue = entries.some((e: any) => e?.minimum_deadline?.status === "past_due");
  const submitted = charges || entries.length === 0 || pastDue;
  const status = charges ? "active" : (pastDue ? "restricted" : "onboarding");
  const upd: any = { charges_enabled: charges, payouts_enabled: charges, details_submitted: submitted, status, requirements: reqs ? { summary: reqs.summary || null, count: entries.length, card_payments: cardStatus } : null, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (charges && !pa.connected_at) upd.connected_at = new Date().toISOString();
  const { data } = await supabase.from("payment_accounts").update(upd).eq("account_id", acct.id).select("*").maybeSingle();
  if (charges && acct.settings?.payments?.enabled !== true) await setPaymentsEnabled(acct, true);
  return data || { ...pa, ...upd };
}

async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try {
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) });
    const j: any = await r.json().catch(() => ({}));
    if (!j?.ok) return false;
    try {
      const { data: cv } = await supabase.from("conversations").upsert({ account_id: accountId, channel: "sms", customer_identifier: to, last_outbound_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle();
      if (cv?.id) await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: cv.id, direction: "outbound", actor: "donna", channel: "sms", body, status: "sent" });
    } catch { /* non-fatal */ }
    return true;
  } catch { return false; }
}
async function sendEmail(to: string, from: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text }) }); return r.ok; } catch { return false; }
}

// Gift cards redeemed on a ticket must exist, be active, and cover the amount. Returns an error string or null.
async function checkGiftCards(accountId: string, lines: any[]): Promise<string | null> {
  for (const l of lines.filter((x) => x.kind === "gift_card")) {
    if (!l.code) return "gift_card_code_missing";
    const { data: g } = await supabase.from("gift_cards").select("id, balance_cents, status, expires_at").eq("account_id", accountId).eq("code", l.code).maybeSingle();
    if (!g || g.status !== "active") return `gift_card_not_found:${l.code}`;
    if (g.expires_at && new Date(g.expires_at).getTime() < Date.now()) return `gift_card_expired:${l.code}`;
    if (Math.abs(l.cents) > g.balance_cents) return `gift_card_balance:${l.code}:${g.balance_cents}`;
  }
  return null;
}
const newGiftCode = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(8)); for (const b of r) s += a[b % a.length]; return s.slice(0, 4) + "-" + s.slice(4); };
// Once a ticket is paid: stock goes down, redeemed gift cards lose balance, sold gift cards are issued (and texted to the recipient).
async function afterPaid(inv: any, acct: any) {
  const lines: any[] = inv.lines || [];
  for (const l of lines) {
    try {
      if (l.kind === "product" && l.product_id) {
        const { data: p } = await supabase.from("products").select("stock").eq("id", l.product_id).maybeSingle();
        if (p && p.stock != null) await supabase.from("products").update({ stock: Math.max(0, p.stock - (Number(l.qty) || 1)), updated_at: new Date().toISOString() }).eq("id", l.product_id);
      } else if (l.kind === "gift_card" && l.code) {
        const { data: g } = await supabase.from("gift_cards").select("id, balance_cents").eq("account_id", inv.account_id).eq("code", l.code).maybeSingle();
        if (g) { const bal = Math.max(0, g.balance_cents - Math.abs(l.cents)); await supabase.from("gift_cards").update({ balance_cents: bal, status: bal === 0 ? "used" : "active", updated_at: new Date().toISOString() }).eq("id", g.id); await supabase.from("gift_card_moves").insert({ gift_card_id: g.id, invoice_id: inv.id, delta_cents: -Math.abs(l.cents), note: `Redeemed on ${inv.number}` }); }
      } else if (l.kind === "gift_card_sale") {
        let code = newGiftCode(); for (let i = 0; i < 5; i++) { const { data: dup } = await supabase.from("gift_cards").select("id").eq("account_id", inv.account_id).eq("code", code).maybeSingle(); if (!dup) break; code = newGiftCode(); }
        const { data: g } = await supabase.from("gift_cards").insert({ account_id: inv.account_id, code, initial_cents: l.cents, balance_cents: l.cents, purchaser_contact_id: inv.contact_id || null, recipient_name: l.recipient_name || null, recipient_phone: l.recipient_phone || null, sold_invoice_id: inv.id }).select("id").maybeSingle();
        if (g) await supabase.from("gift_card_moves").insert({ gift_card_id: g.id, invoice_id: inv.id, delta_cents: l.cents, note: `Sold on ${inv.number}` });
        const to = l.recipient_phone || inv.customer_phone;
        if (to && acct?.settings?.sms?.enabled === true) await sendText(inv.account_id, to, `${acct.name}: ${l.recipient_name ? l.recipient_name + ", " : ""}you have a ${money(l.cents)} gift card. Code ${code}. Give the code at checkout; we track the balance for you.`);
      }
    } catch (e) { console.error("afterPaid line", String(e)); }
  }
}

async function markPaid(inv: any, method: string, provider: string, providerRef: string | null, note: string | null, amountCents?: number, feeCents?: number, surchargeCents = 0) {
  if (inv.paid_at) return inv;
  const now = new Date().toISOString();
  const paidNote = surchargeCents > 0 ? `${note ? note + "; " : ""}incl. ${money(surchargeCents)} card processing fee` : note;
  const { data } = await supabase.from("invoices").update({ status: "paid", paid_at: now, paid_method: method, paid_note: paidNote, stripe_payment_intent_id: providerRef && provider === "stripe" ? providerRef : inv.stripe_payment_intent_id, updated_at: now }).eq("id", inv.id).select("*").maybeSingle();
  await supabase.from("payments").insert({ account_id: inv.account_id, invoice_id: inv.id, amount_cents: amountCents ?? inv.total_cents, method, provider, provider_ref: providerRef, fee_cents: feeCents ?? null, note: paidNote, tip_cents: inv.tip_cents || 0 });
  // Only the job's final invoice closes the job; an after-hours prepay invoice (job_id set, but not the job's invoice_id) leaves it open.
  if (inv.job_id) { try { await supabase.from("jobs").update({ status: "paid", updated_at: now }).eq("id", inv.job_id).eq("invoice_id", inv.id); } catch { /* jobs may not exist yet */ } }
  // After-hours prepay cleared (any method): page the on-call tech with the job, tell the customer. Card payments also text whoever sent the invoice.
  try {
    const acct = await loadAccount(inv.account_id);
    let who: any = null;
    if (inv.created_by) { const { data } = await supabase.from("users").select("phone, full_name").eq("id", inv.created_by).maybeSingle(); who = data; }
    if (!who?.phone) { const { data } = await supabase.from("users").select("phone, full_name").eq("account_id", inv.account_id).eq("role", "owner").not("phone", "is", null).limit(1).maybeSingle(); who = data; }
    let paged = false;
    if (inv.job_id && acct) {
      const { data: job } = await supabase.from("jobs").select("kind, customer_name, customer_phone, address, notes, invoice_id").eq("id", inv.job_id).maybeSingle();
      if (job?.kind === "emergency" && job.invoice_id !== inv.id) {
        const ctr: any = acct.settings?.contractor || {};
        const pagePhone = String(ctr.after_hours_page_phone || who?.phone || "").trim();
        if (pagePhone) { try { const r = await fetch(`${SELF}/oncall`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "page", account_id: inv.account_id, job_id: inv.job_id, message: `FEE PAID (${money(amountCents ?? inv.total_cents)}): ${job.customer_name || "Caller"}${job.customer_phone ? " " + job.customer_phone : ""}${job.address ? " at " + job.address : ""}. ${String(job.notes || "").slice(0, 300)}. Call them back now.` }) }); const j: any = await r.json().catch(() => ({})); paged = !!j?.ok; } catch { paged = false; } }
        if (job.customer_phone) await sendText(inv.account_id, job.customer_phone, `${acct.name}: got it, thank you. The on-call technician has been paged and will call you shortly.`);
      }
    }
    if (provider === "stripe" && !paged && who?.phone && acct) await sendText(inv.account_id, who.phone, `${acct.name}: ${inv.customer_name || "Your customer"} paid invoice ${inv.number}, ${money(amountCents ?? inv.total_cents)} by card. It's on its way to your bank.`);
    // Stock, gift-card balances and new gift cards move only once the money is in.
    if (acct) await afterPaid(inv, acct);
    // Customer receipt, every payment method (card, cash, check, gift card, other): text and/or email, with the pay page as the itemized receipt.
    if (acct) {
      const amt = money(amountCents ?? inv.total_cents); const link = payUrl(inv.pay_token);
      const how = method === "card" ? "card" : method === "check" ? "check" : method === "cash" ? "cash" : method === "gift_card" ? "gift card" : (note || method || "payment");
      const word = inv.kind === "ticket" ? "visit" : "invoice";
      if (inv.customer_phone && acct.settings?.sms?.enabled === true) await sendText(inv.account_id, inv.customer_phone, `${acct.name}: paid, thank you. ${amt} for your ${word} ${inv.number} (${how})${inv.tip_cents ? ", including a " + money(inv.tip_cents) + " tip" : ""}. Your receipt: ${link}`);
      if (inv.customer_email) {
        const lines = (inv.lines || []).map((l: any) => `  ${l.desc}${l.qty > 1 ? ` x${l.qty}` : ""}  ${money(l.cents)}`).join("\n");
        await sendEmail(inv.customer_email, `${acct.name} via Donna <donna@sidekicklogistics.com>`, `Receipt from ${acct.name} - ${amt} - ${inv.number}`, `Hi${inv.customer_name ? " " + inv.customer_name : ""},\n\nThank you. We received ${amt} (${how}) for ${word} ${inv.number}.\n\n${lines}${inv.tax_cents ? `\n  Sales tax  ${money(inv.tax_cents)}` : ""}${inv.tip_cents ? `\n  Tip  ${money(inv.tip_cents)}` : ""}${surchargeCents > 0 ? `\n  Card processing fee  ${money(surchargeCents)}` : ""}\n\nTotal: ${money(inv.total_cents + surchargeCents)}\nPaid: ${amt}\n\nYour receipt: ${link}\n\n${acct.name}`);
      }
    }
  } catch { /* non-fatal */ }
  return data || inv;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  await ensureStripe();
  const url = new URL(req.url);
  const pathAction = url.pathname.split("/").filter(Boolean).pop();

  // ---- Stripe webhook (Connect endpoint; events from connected accounts carry event.account) ----
  if (pathAction === "webhook" || req.headers.get("stripe-signature")) {
    if (!stripe || !WEBHOOK_SECRET) return json({ ok: false, error: "stripe_not_configured" }, 503);
    const sig = req.headers.get("stripe-signature") || ""; const raw = await req.text();
    let ev: any;
    try { ev = await stripe.webhooks.constructEventAsync(raw, sig, WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider()); }
    catch (e) { return json({ ok: false, error: "bad_signature", detail: String(e) }, 400); }
    try {
      if (ev.type === "checkout.session.completed" && ev.data.object?.mode === "setup") {
        // Card on file: the customer saved a card for a booked job. Keep the ids on the job; the tech can charge it at Done.
        const cs = ev.data.object; const jobId = cs?.metadata?.job_id; const acctStripe = ev.account || cs?.metadata?.stripe_account || null;
        if (jobId && cs.setup_intent && acctStripe) {
          try {
            const si: any = await stripe.setupIntents.retrieve(String(cs.setup_intent), { expand: ["payment_method"] }, { stripeAccount: acctStripe });
            const pm: any = si?.payment_method || {};
            const card = { payment_method: pm.id || String(si.payment_method || ""), customer: cs.customer || si.customer || null, brand: pm.card?.brand || null, last4: pm.card?.last4 || null, saved_at: new Date().toISOString() };
            const { data: job } = await supabase.from("jobs").update({ card, updated_at: new Date().toISOString() }).eq("id", jobId).select("account_id, customer_phone, customer_name, assigned_user_id").maybeSingle();
            if (job) { const acct = await loadAccount(job.account_id); if (acct && job.customer_phone && acct.settings?.sms?.enabled === true) await sendText(job.account_id, job.customer_phone, `${acct.name}: thanks, your card ending ${card.last4 || "on file"} is saved. Nothing is charged until the work is done.`); }
          } catch (e) { console.error("card setup webhook", e); }
        }
      } else if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
        const cs = ev.data.object; const invoiceId = cs?.metadata?.invoice_id;
        if (invoiceId && cs.payment_status === "paid") {
          const { data: inv } = await supabase.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
          if (inv) await markPaid(inv, "card", "stripe", String(cs.payment_intent || cs.id), null, cs.amount_total ?? inv.total_cents, undefined, Number(cs?.metadata?.card_fee_cents || 0));
        }
      } else if (ev.type === "account.updated") {
        const a = ev.data.object; const { data: pa } = await supabase.from("payment_accounts").select("*").eq("stripe_account_id", a.id).maybeSingle();
        if (pa) { const acct = await loadAccount(pa.account_id); if (acct) await refreshStatus(acct, pa); }
      }
    } catch (e) { console.error("webhook handling", e); }
    return json({ received: true });
  }

  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || pathAction || "status");

  // ---- Public: create a Checkout Session for one invoice (pay page) ----
  if (action === "checkout") {
    const token = String(body.token || "").trim(); if (!token) return json({ ok: false, error: "no_token" }, 400);
    const { data: inv } = await supabase.from("invoices").select("*").eq("pay_token", token).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404);
    if (inv.paid_at || inv.status === "paid") return json({ ok: false, error: "already_paid" });
    if (inv.status === "void") return json({ ok: false, error: "void" });
    const acct = await loadAccount(inv.account_id); const pa = await loadPA(inv.account_id);
    // Tip chosen on the pay page (tickets only). Saved on the invoice so the receipt and the stylist report see it.
    if (body.tip_cents !== undefined && inv.kind === "ticket" && acct?.settings?.payments?.tips !== false) {
      const tip = Math.max(0, Math.min(Math.round(Number(body.tip_cents) || 0), 100000));
      if (tip !== (inv.tip_cents || 0)) { const { data: upd } = await supabase.from("invoices").update({ tip_cents: tip, updated_at: new Date().toISOString() }).eq("id", inv.id).select("*").maybeSingle(); if (upd) Object.assign(inv, upd); }
    }
    if (!stripe) return json({ ok: false, error: "stripe_not_configured" }, 503);
    if (!acct?.settings?.payments?.enabled || !pa?.charges_enabled || !pa?.stripe_account_id) return json({ ok: false, error: "online_payments_off" });
    const lines = (inv.lines || []).filter((l: any) => l.kind !== "discount" && l.kind !== "tax" && l.cents > 0);
    const discount = (inv.lines || []).filter((l: any) => l.kind === "discount").reduce((s: number, l: any) => s + Math.abs(l.cents), 0);
    const tax = inv.tax_cents || 0;
    // Stripe line items can't be negative: when there's a discount, collapse to one line for the total.
    const fee = cardFee(acct, inv.total_cents);
    const items = (discount > 0 || lines.length === 0)
      ? [{ quantity: 1, price_data: { currency: inv.currency, unit_amount: inv.total_cents, product_data: { name: `Invoice ${inv.number}` } } }]
      : [...lines.map((l: any) => ({ quantity: 1, price_data: { currency: inv.currency, unit_amount: l.cents, product_data: { name: l.desc.slice(0, 120) } } })),
         ...(tax > 0 ? [{ quantity: 1, price_data: { currency: inv.currency, unit_amount: tax, product_data: { name: "Sales tax" } } }] : [])];
    if (inv.tip_cents > 0 && !(discount > 0 || lines.length === 0)) items.push({ quantity: 1, price_data: { currency: inv.currency, unit_amount: inv.tip_cents, product_data: { name: "Tip" } } });
    if (fee.cents > 0) items.push({ quantity: 1, price_data: { currency: inv.currency, unit_amount: fee.cents, product_data: { name: `Card processing fee (${fee.pct}%)` } } });
    try {
      const session: any = await stripe.checkout.sessions.create({
        mode: "payment", line_items: items,
        success_url: `${payUrl(token)}?paid=1`, cancel_url: payUrl(token),
        customer_email: inv.customer_email || undefined,
        metadata: { invoice_id: inv.id, account_id: inv.account_id, number: inv.number, card_fee_cents: String(fee.cents) },
        payment_intent_data: { description: `${acct.name} · Invoice ${inv.number}${fee.cents ? " (incl. card fee)" : ""}`, metadata: { invoice_id: inv.id, card_fee_cents: String(fee.cents) } },
      }, { stripeAccount: pa.stripe_account_id });
      await supabase.from("invoices").update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() }).eq("id", inv.id);
      return json({ ok: true, url: session.url });
    } catch (e) { console.error("checkout", e); return json({ ok: false, error: "stripe_error", detail: String((e as any)?.message || e) }, 502); }
  }

  // ---- Everything else needs a signed-in user ----
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const business = acct.name || "Your business";

  if (action === "status") {
    let pa = await loadPA(acct.id);
    if (pa?.stripe_account_id && stripe && (!pa.last_checked_at || Date.now() - new Date(pa.last_checked_at).getTime() > 10 * 60 * 1000)) { try { pa = await refreshStatus(acct, pa); } catch { /* keep cached */ } }
    const { count: openCount } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("account_id", acct.id).eq("status", "sent");
    return json({ ok: true, configured: !!stripe, enabled: acct.settings?.payments?.enabled === true, account: pa || { status: "not_connected" }, open_invoices: openCount || 0 });
  }

  if (action === "connect") {
    if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);
    if (!stripe) return json({ ok: false, error: "stripe_not_configured", message: "Online payments aren't switched on for Donna yet. Mark invoices paid by hand for now." }, 503);
    try {
      let pa = await loadPA(acct.id);
      if (!pa?.stripe_account_id) {
        const { data: owner } = await supabase.from("users").select("email, full_name").eq("id", caller.userId).maybeSingle();
        // SaaS pattern: the contractor is the merchant of record, has the full Stripe Dashboard, pays Stripe's fees directly; Stripe owns losses. Donna takes nothing.
        const created: any = await stripeV2("POST", "/v2/core/accounts", {
          display_name: business, contact_email: (owner as any)?.email || undefined,
          dashboard: "full",
          defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" }, locales: ["en-US"] },
          identity: { country: "us" },
          configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
          metadata: { donna_account_id: acct.id },
          include: ["configuration.merchant", "requirements"],
        });
        const row = { account_id: acct.id, provider: "stripe", stripe_account_id: created.id, status: "onboarding", updated_at: new Date().toISOString() };
        const { data } = await supabase.from("payment_accounts").upsert(row, { onConflict: "account_id" }).select("*").maybeSingle(); pa = data;
      }
      const link: any = await stripeV2("POST", "/v2/core/account_links", { account: pa.stripe_account_id, use_case: { type: "account_onboarding", account_onboarding: { refresh_url: `${APP}/?payments=refresh`, return_url: `${APP}/?payments=return`, collection_options: { fields: "currently_due" } } } });
      return json({ ok: true, url: link.url });
    } catch (e) { console.error("connect", e); return json({ ok: false, error: "stripe_error", message: "Stripe didn't accept that just now. Try again in a minute.", detail: String((e as any)?.message || e) }, 502); }
  }

  if (action === "refresh") {
    const pa = await loadPA(acct.id); if (!pa?.stripe_account_id) return json({ ok: true, account: pa || { status: "not_connected" }, enabled: false });
    try { const upd = await refreshStatus(acct, pa); const fresh = await loadAccount(acct.id); return json({ ok: true, account: upd, enabled: fresh?.settings?.payments?.enabled === true }); }
    catch (e) { return json({ ok: false, error: "stripe_error", detail: String((e as any)?.message || e) }, 502); }
  }

  if (action === "enable" || action === "disable") {
    if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);
    const pa = await loadPA(acct.id);
    if (action === "enable" && !pa?.charges_enabled) return json({ ok: false, error: "not_connected", message: "Connect your Stripe account first." });
    await setPaymentsEnabled(acct, action === "enable"); return json({ ok: true, enabled: action === "enable" });
  }

  // ---- Invoices ----
  if (action === "invoice_create") {
    const lines = normLines(body.lines); if (!lines.length) return json({ ok: false, error: "no_lines" }, 400);
    let contact: any = null;
    if (body.contact_id) { const { data } = await supabase.from("contacts").select("id, name, phone, email").eq("id", body.contact_id).eq("account_id", acct.id).maybeSingle(); contact = data; }
    const gcErr = await checkGiftCards(acct.id, lines); if (gcErr) return json({ ok: false, error: gcErr }, 400);
    // Salon ticket: the appointment supplies the client and the stylist (served_by) unless given.
    let appt: any = null;
    if (body.appointment_id) { const { data } = await supabase.from("appointments").select("id, contact_id, user_id, contacts(name, phone, email)").eq("id", body.appointment_id).eq("account_id", acct.id).maybeSingle(); appt = data; if (!contact && appt?.contacts) contact = { id: appt.contact_id, ...(appt.contacts as any) }; }
    const kind = body.kind === "ticket" ? "ticket" : "invoice";
    const servedBy = body.served_by || appt?.user_id || (kind === "ticket" ? caller.userId : null);
    const tip = Math.max(0, Math.min(Math.round(Number(body.tip_cents) || 0), 100000));
    const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acct.id });
    const row: any = {
      account_id: acct.id, contact_id: contact?.id || null, appointment_id: body.appointment_id || null, job_id: body.job_id || null,
      number: num || `INV-${Date.now().toString().slice(-6)}`, status: "draft", lines, notes: String(body.notes || "").slice(0, 1000) || null,
      customer_name: String(body.customer_name || contact?.name || "").slice(0, 120) || null,
      customer_phone: String(body.customer_phone || contact?.phone || "").trim() || null,
      customer_email: String(body.customer_email || contact?.email || "").trim() || null,
      service_address: String(body.service_address || "").slice(0, 240) || null, created_by: caller.userId,
      kind, served_by: servedBy, tip_cents: tip,
    };
    const { data, error } = await supabase.from("invoices").insert(row).select("*").maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    // A ticket fully covered by a gift card (or $0) is paid on the spot.
    if (kind === "ticket" && body.pay_now && data.total_cents <= 0) { const upd = await markPaid(data, "gift_card", "manual", null, null); await logActivity(acct.id, caller.userId, "invoice.paid", "invoice", data.id, data.number, { method: "gift_card", total_cents: 0 }); return json({ ok: true, invoice: upd, pay_url: payUrl(data.pay_token) }); }
    return json({ ok: true, invoice: data, pay_url: payUrl(data.pay_token) });
  }

  if (action === "invoice_update") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    if (!(await canTouchInvoice(caller, inv))) return json({ ok: false, error: "not_yours", message: "That invoice belongs to someone else on the team." }, 403);
    if (body.lines && inv.status !== "draft" && !isAdmin(caller.role)) return json({ ok: false, error: "admins_only", message: "Only an owner or manager can change a sent invoice." }, 403);
    const upd: any = { updated_at: new Date().toISOString() };
    if (body.lines) { const lines = normLines(body.lines); if (!lines.length) return json({ ok: false, error: "no_lines" }, 400); const gcErr = await checkGiftCards(acct.id, lines); if (gcErr) return json({ ok: false, error: gcErr }, 400); upd.lines = lines; }
    if (body.tip_cents !== undefined) upd.tip_cents = Math.max(0, Math.min(Math.round(Number(body.tip_cents) || 0), 100000));
    if (body.served_by !== undefined) upd.served_by = body.served_by || null;
    for (const k of ["notes", "customer_name", "customer_phone", "customer_email", "service_address"]) if (body[k] !== undefined) upd[k] = String(body[k] || "").trim() || null;
    const { data } = await supabase.from("invoices").update(upd).eq("id", id).select("*").maybeSingle();
    if (body.lines && inv.status !== "draft" && data && data.total_cents !== inv.total_cents) await logActivity(acct.id, caller.userId, "invoice.reprice", "invoice", inv.id, inv.number, { from_cents: inv.total_cents, to_cents: data.total_cents });
    return json({ ok: true, invoice: data, pay_url: payUrl(data.pay_token) });
  }

  if (action === "invoice_send") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    if (!(await canTouchInvoice(caller, inv))) return json({ ok: false, error: "not_yours", message: "That invoice belongs to someone else on the team." }, 403);
    const to = String(body.to || inv.customer_phone || "").trim(); const email = String(body.email || inv.customer_email || "").trim();
    const pa = await loadPA(acct.id); const online = acct.settings?.payments?.enabled === true && pa?.charges_enabled === true;
    const link = payUrl(inv.pay_token); const total = money(inv.total_cents);
    const sfee = cardFee(acct, inv.total_cents);
    const text = online
      ? `${business}: your invoice ${inv.number} for ${total} is ready. Tap to view and pay: ${link}${sfee.cents ? ` (${sfee.pct}% card fee if paying by card; cash or check is ${total})` : ""}`
      : `${business}: your invoice ${inv.number} for ${total} is ready. View it here: ${link}`;
    let sentSms = false, sentEmail = false;
    if (to && acct.settings?.sms?.enabled === true) sentSms = await sendText(acct.id, to, text);
    if (email) {
      const from = `${business} via Donna <donna@sidekicklogistics.com>`;
      const lines = (inv.lines || []).map((l: any) => `  ${l.desc}${l.qty > 1 ? ` x${l.qty}` : ""}  ${money(l.cents)}`).join("\n");
      sentEmail = await sendEmail(email, from, `Invoice ${inv.number} from ${business} - ${total}`, `Hi${inv.customer_name ? " " + inv.customer_name : ""},\n\nHere is your invoice from ${business}.\n\n${lines}\n\nTotal: ${total}\n\n${online ? "View and pay online: " : "View it here: "}${link}\n\n${inv.notes ? inv.notes + "\n\n" : ""}Thank you,\n${business}`);
    }
    if (!sentSms && !sentEmail) return json({ ok: false, error: "not_sent", message: to ? "The text didn't go through. Check the customer's number or that texting is on." : "No phone or email on this invoice.", pay_url: link });
    const { data } = await supabase.from("invoices").update({ status: "sent", sent_at: new Date().toISOString(), sent_channel: sentSms && sentEmail ? "sms+email" : (sentSms ? "sms" : "email"), customer_phone: to || inv.customer_phone, customer_email: email || inv.customer_email, updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    if (inv.job_id) { try { await supabase.from("jobs").update({ status: "invoiced", updated_at: new Date().toISOString() }).eq("id", inv.job_id).eq("invoice_id", inv.id); } catch { /* ok */ } }
    return json({ ok: true, invoice: data, pay_url: link, sent: { sms: sentSms, email: sentEmail }, online });
  }

  if (action === "invoice_mark_paid") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404);
    if (!(await canTouchInvoice(caller, inv))) return json({ ok: false, error: "not_yours", message: "That invoice belongs to someone else on the team." }, 403);
    const method = ["cash", "check", "card", "other", "gift_card", "zelle", "venmo"].includes(body.method) ? body.method : "cash";
    if (body.tip_cents !== undefined && !inv.paid_at) { const tip = Math.max(0, Math.min(Math.round(Number(body.tip_cents) || 0), 100000)); if (tip !== (inv.tip_cents || 0)) { const { data: t } = await supabase.from("invoices").update({ tip_cents: tip, updated_at: new Date().toISOString() }).eq("id", inv.id).select("*").maybeSingle(); if (t) Object.assign(inv, t); } }
    const upd = await markPaid(inv, method, "manual", null, String(body.note || "").slice(0, 200) || null);
    await logActivity(acct.id, caller.userId, "invoice.paid", "invoice", inv.id, inv.number, { method, total_cents: inv.total_cents });
    return json({ ok: true, invoice: upd });
  }

  if (action === "card_setup_send") {
    // Text the customer a Stripe Checkout (setup mode) link on the business's own account. Nothing is charged; the card is saved to the job.
    const pa = await loadPA(acct.id);
    if (!stripe || !acct.settings?.payments?.enabled || !pa?.charges_enabled || !pa?.stripe_account_id) return json({ ok: false, error: "online_payments_off", message: "Connect Stripe and turn on online payments first." });
    let job: any = null;
    if (body.job_id) { const { data } = await supabase.from("jobs").select("*").eq("id", body.job_id).eq("account_id", acct.id).maybeSingle(); job = data; }
    else if (body.appointment_id) {
      const { data } = await supabase.from("jobs").select("*").eq("appointment_id", body.appointment_id).eq("account_id", acct.id).maybeSingle(); job = data;
      if (!job) { const { data: a } = await supabase.from("appointments").select("id, contact_id, user_id, title, starts_at, location_address, notes, customer_email, contacts(name, phone, email)").eq("id", body.appointment_id).eq("account_id", acct.id).maybeSingle(); if (a) { const c: any = (a as any).contacts || {}; const { data: nj } = await supabase.from("jobs").upsert({ account_id: acct.id, appointment_id: a.id, contact_id: a.contact_id, assigned_user_id: a.user_id, title: a.title || "Job", kind: "service", status: "scheduled", customer_name: c.name || null, customer_phone: c.phone || null, customer_email: c.email || a.customer_email || null, address: a.location_address || null, scheduled_at: a.starts_at, notes: a.notes || null }, { onConflict: "appointment_id" }).select("*").maybeSingle(); job = nj; } }
    }
    if (!job) return json({ ok: false, error: "job_not_found" }, 404);
    if (job.card?.payment_method) return json({ ok: true, already: true, last4: job.card.last4 || null });
    const to = String(body.phone || job.customer_phone || "").trim(); if (!to) return json({ ok: false, error: "no_phone" });
    try {
      const session: any = await stripe.checkout.sessions.create({
        mode: "setup", payment_method_types: ["card"], customer_email: job.customer_email || undefined,
        success_url: `${APP}/pay/card-saved`, cancel_url: `${APP}/pay/card-saved?cancel=1`,
        metadata: { job_id: job.id, account_id: acct.id, stripe_account: pa.stripe_account_id },
        setup_intent_data: { metadata: { job_id: job.id, account_id: acct.id } },
      } as any, { stripeAccount: pa.stripe_account_id });
      const when = job.scheduled_at ? new Intl.DateTimeFormat("en-US", { timeZone: acct.settings?.timezone || "America/Chicago", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(job.scheduled_at)) : "your appointment";
      const sent = acct.settings?.sms?.enabled === true ? await sendText(acct.id, to, `${business}: to hold ${when}, please put a card on file here (nothing is charged now; you're billed only when the work is done): ${session.url}`) : false;
      await supabase.from("jobs").update({ card: { requested_at: new Date().toISOString(), session_id: session.id }, updated_at: new Date().toISOString() }).eq("id", job.id);
      return json({ ok: true, sent, url: session.url });
    } catch (e) { console.error("card setup", e); return json({ ok: false, error: "stripe_error", detail: String((e as any)?.message || e) }, 502); }
  }

  if (action === "invoice_charge_card") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    if (!(await canTouchInvoice(caller, inv))) return json({ ok: false, error: "not_yours", message: "That invoice belongs to someone else on the team." }, 403);
    const pa = await loadPA(acct.id);
    if (!stripe || !pa?.charges_enabled || !pa?.stripe_account_id) return json({ ok: false, error: "online_payments_off" });
    const { data: job } = inv.job_id ? await supabase.from("jobs").select("card, customer_name").eq("id", inv.job_id).maybeSingle() : { data: null as any };
    const card = (job as any)?.card; if (!card?.payment_method) return json({ ok: false, error: "no_card", message: "No card on file for this job. Send the pay link instead." });
    try {
      const fee = cardFee(acct, inv.total_cents);
      const pi: any = await stripe.paymentIntents.create({ amount: inv.total_cents + fee.cents, currency: inv.currency || "usd", customer: card.customer || undefined, payment_method: card.payment_method, off_session: true, confirm: true, description: `${business} \u00b7 Invoice ${inv.number}${fee.cents ? " (incl. card fee)" : ""}`, metadata: { invoice_id: inv.id, account_id: acct.id, number: inv.number, card_fee_cents: String(fee.cents) } }, { stripeAccount: pa.stripe_account_id });
      if (pi.status === "succeeded") { const upd = await markPaid(inv, "card", "stripe", pi.id, `card on file${card.last4 ? " \u2022\u2022\u2022\u2022 " + card.last4 : ""}`, pi.amount_received ?? (inv.total_cents + fee.cents), undefined, fee.cents); return json({ ok: true, invoice: upd, charged: true, last4: card.last4 || null, card_fee_cents: fee.cents, total_charged: inv.total_cents + fee.cents }); }
      return json({ ok: false, error: "not_succeeded", status: pi.status, message: "The bank wants the customer to confirm. Send them the pay link." });
    } catch (e: any) {
      const code = e?.code || e?.raw?.code || ""; console.error("charge card", code, e?.message);
      return json({ ok: false, error: code === "authentication_required" ? "needs_customer" : "card_declined", message: code === "authentication_required" ? "Their bank wants them to confirm. Send the pay link and they can finish it on their phone." : `The card was declined${e?.decline_code ? " (" + e.decline_code + ")" : ""}. Send the pay link so they can use another card.` });
    }
  }

  if (action === "invoice_void") {
    if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only", message: "Only an owner or manager can void an invoice." }, 403);
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    const { data } = await supabase.from("invoices").update({ status: "void", updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    await logActivity(acct.id, caller.userId, "invoice.void", "invoice", inv.id, inv.number, { total_cents: inv.total_cents });
    return json({ ok: true, invoice: data });
  }

  if (action === "gift_card_lookup") {
    const code = String(body.code || "").trim().toUpperCase(); if (!code) return json({ ok: false, error: "no_code" }, 400);
    const { data: g } = await supabase.from("gift_cards").select("code, initial_cents, balance_cents, status, expires_at, recipient_name").eq("account_id", acct.id).eq("code", code).maybeSingle();
    if (!g) return json({ ok: false, error: "not_found" });
    return json({ ok: true, card: g });
  }

  if (action === "invoice_list") {
    const status = body.status ? String(body.status) : null; const limit = Math.min(200, Number(body.limit) || 50);
    let q = supabase.from("invoices").select("*").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(limit);
    if (status) q = q.eq("status", status);
    // Team members see their own invoices (created by them or on a job assigned to them); owners/managers see all.
    if (!isAdmin(caller.role) || body.mine) {
      const { data: myJobs } = await supabase.from("jobs").select("id").eq("account_id", acct.id).eq("assigned_user_id", caller.userId);
      const ids = (myJobs || []).map((j: any) => j.id);
      q = ids.length ? q.or(`created_by.eq.${caller.userId},job_id.in.(${ids.join(",")})`) : q.eq("created_by", caller.userId);
    }
    const { data } = await q; return json({ ok: true, invoices: (data || []).map((i: any) => ({ ...i, pay_url: payUrl(i.pay_token) })) });
  }

  if (action === "export_csv") {
    const from = body.from ? new Date(body.from) : new Date(Date.now() - 365 * 86400000); const to = body.to ? new Date(body.to) : new Date();
    const { data: invs } = await supabase.from("invoices").select("*").eq("account_id", acct.id).gte("created_at", from.toISOString()).lte("created_at", to.toISOString()).order("created_at");
    const { data: pays } = await supabase.from("payments").select("*, invoices(number)").eq("account_id", acct.id).gte("received_at", from.toISOString()).lte("received_at", to.toISOString()).order("received_at");
    const { data: ppl } = await supabase.from("users").select("id, full_name").eq("account_id", acct.id); const names = new Map((ppl || []).map((u: any) => [u.id, u.full_name]));
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const d = (v: any) => v ? new Date(v).toISOString().slice(0, 10) : "";
    const invCsv = ["Invoice No,Date,Customer,Phone,Email,Service Address,Description,Subtotal,Tax,Tip,Total,Status,Sent,Paid Date,Paid Method,Served By",
      ...(invs || []).map((i: any) => [i.number, d(i.created_at), i.customer_name, i.customer_phone, i.customer_email, i.service_address, (i.lines || []).map((l: any) => `${l.desc}${l.qty > 1 ? " x" + l.qty : ""} ${money(l.cents)}`).join("; "), (i.subtotal_cents / 100).toFixed(2), (i.tax_cents / 100).toFixed(2), ((i.tip_cents || 0) / 100).toFixed(2), (i.total_cents / 100).toFixed(2), i.status, d(i.sent_at), d(i.paid_at), i.paid_method, names.get(i.served_by) || ""].map(esc).join(","))].join("\n");
    const payCsv = ["Date,Invoice No,Amount,Method,Provider,Reference,Fee,Note",
      ...(pays || []).map((p: any) => [d(p.received_at), p.invoices?.number, (p.amount_cents / 100).toFixed(2), p.method, p.provider, p.provider_ref, p.fee_cents != null ? (p.fee_cents / 100).toFixed(2) : "", p.note].map(esc).join(","))].join("\n");
    return json({ ok: true, invoices_csv: invCsv, payments_csv: payCsv, count: { invoices: invs?.length || 0, payments: pays?.length || 0 } });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
