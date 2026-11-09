import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.25.0?target=denonext";

// Donna shared payments module (v7). Any vertical can use it; the dashboard exposes it to contractors first.
// Tenants connect THEIR OWN Stripe account (Connect, Accounts v2, SaaS pattern). Donna never holds, touches or routes money:
// Checkout Sessions are created directly on the tenant's account (Stripe-Account header), no application fee.
//
// User actions (JWT, or service role + user_id from internal callers):
//   status | connect | refresh | enable | disable
//   invoice_create | invoice_update | invoice_send | invoice_mark_paid | invoice_void | invoice_list | export_csv
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
    const kind = ["service", "addon", "trip_fee", "discount", "tax", "material", "labor"].includes(l.kind) ? l.kind : "service";
    const cents = l.cents != null ? Math.round(Number(l.cents)) : Math.round(qty * unit) * (kind === "discount" ? -1 : 1);
    return { desc: String(l.desc || l.name || "").slice(0, 140), qty, unit_cents: unit, cents, kind };
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

async function markPaid(inv: any, method: string, provider: string, providerRef: string | null, note: string | null, amountCents?: number, feeCents?: number) {
  if (inv.paid_at) return inv;
  const now = new Date().toISOString();
  const { data } = await supabase.from("invoices").update({ status: "paid", paid_at: now, paid_method: method, paid_note: note, stripe_payment_intent_id: providerRef && provider === "stripe" ? providerRef : inv.stripe_payment_intent_id, updated_at: now }).eq("id", inv.id).select("*").maybeSingle();
  await supabase.from("payments").insert({ account_id: inv.account_id, invoice_id: inv.id, amount_cents: amountCents ?? inv.total_cents, method, provider, provider_ref: providerRef, fee_cents: feeCents ?? null, note });
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
        if (pagePhone) { paged = await sendText(inv.account_id, pagePhone, `${acct.name} AFTER-HOURS, FEE PAID (${money(amountCents ?? inv.total_cents)}): ${job.customer_name || "Caller"}${job.customer_phone ? " " + job.customer_phone : ""}${job.address ? " at " + job.address : ""}. ${String(job.notes || "").slice(0, 300)}. Call them back now.`); }
        if (job.customer_phone) await sendText(inv.account_id, job.customer_phone, `${acct.name}: got it, thank you. The on-call technician has been paged and will call you shortly.`);
      }
    }
    if (provider === "stripe" && !paged && who?.phone && acct) await sendText(inv.account_id, who.phone, `${acct.name}: ${inv.customer_name || "Your customer"} paid invoice ${inv.number}, ${money(amountCents ?? inv.total_cents)} by card. It's on its way to your bank.`);
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
      if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
        const cs = ev.data.object; const invoiceId = cs?.metadata?.invoice_id;
        if (invoiceId && cs.payment_status === "paid") {
          const { data: inv } = await supabase.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
          if (inv) await markPaid(inv, "card", "stripe", String(cs.payment_intent || cs.id), null, cs.amount_total ?? inv.total_cents);
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
    if (!stripe) return json({ ok: false, error: "stripe_not_configured" }, 503);
    if (!acct?.settings?.payments?.enabled || !pa?.charges_enabled || !pa?.stripe_account_id) return json({ ok: false, error: "online_payments_off" });
    const lines = (inv.lines || []).filter((l: any) => l.kind !== "discount" && l.kind !== "tax" && l.cents > 0);
    const discount = (inv.lines || []).filter((l: any) => l.kind === "discount").reduce((s: number, l: any) => s + Math.abs(l.cents), 0);
    const tax = inv.tax_cents || 0;
    // Stripe line items can't be negative: when there's a discount, collapse to one line for the total.
    const items = (discount > 0 || lines.length === 0)
      ? [{ quantity: 1, price_data: { currency: inv.currency, unit_amount: inv.total_cents, product_data: { name: `Invoice ${inv.number}` } } }]
      : [...lines.map((l: any) => ({ quantity: 1, price_data: { currency: inv.currency, unit_amount: l.cents, product_data: { name: l.desc.slice(0, 120) } } })),
         ...(tax > 0 ? [{ quantity: 1, price_data: { currency: inv.currency, unit_amount: tax, product_data: { name: "Sales tax" } } }] : [])];
    try {
      const session: any = await stripe.checkout.sessions.create({
        mode: "payment", line_items: items,
        success_url: `${payUrl(token)}?paid=1`, cancel_url: payUrl(token),
        customer_email: inv.customer_email || undefined,
        metadata: { invoice_id: inv.id, account_id: inv.account_id, number: inv.number },
        payment_intent_data: { description: `${acct.name} · Invoice ${inv.number}`, metadata: { invoice_id: inv.id } },
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
    const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acct.id });
    const row: any = {
      account_id: acct.id, contact_id: contact?.id || null, appointment_id: body.appointment_id || null, job_id: body.job_id || null,
      number: num || `INV-${Date.now().toString().slice(-6)}`, status: "draft", lines, notes: String(body.notes || "").slice(0, 1000) || null,
      customer_name: String(body.customer_name || contact?.name || "").slice(0, 120) || null,
      customer_phone: String(body.customer_phone || contact?.phone || "").trim() || null,
      customer_email: String(body.customer_email || contact?.email || "").trim() || null,
      service_address: String(body.service_address || "").slice(0, 240) || null, created_by: caller.userId,
    };
    const { data, error } = await supabase.from("invoices").insert(row).select("*").maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 400);
    return json({ ok: true, invoice: data, pay_url: payUrl(data.pay_token) });
  }

  if (action === "invoice_update") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    const upd: any = { updated_at: new Date().toISOString() };
    if (body.lines) { const lines = normLines(body.lines); if (!lines.length) return json({ ok: false, error: "no_lines" }, 400); upd.lines = lines; }
    for (const k of ["notes", "customer_name", "customer_phone", "customer_email", "service_address"]) if (body[k] !== undefined) upd[k] = String(body[k] || "").trim() || null;
    const { data } = await supabase.from("invoices").update(upd).eq("id", id).select("*").maybeSingle();
    return json({ ok: true, invoice: data, pay_url: payUrl(data.pay_token) });
  }

  if (action === "invoice_send") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    const to = String(body.to || inv.customer_phone || "").trim(); const email = String(body.email || inv.customer_email || "").trim();
    const pa = await loadPA(acct.id); const online = acct.settings?.payments?.enabled === true && pa?.charges_enabled === true;
    const link = payUrl(inv.pay_token); const total = money(inv.total_cents);
    const text = online
      ? `${business}: your invoice ${inv.number} for ${total} is ready. Tap to view and pay: ${link}`
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
    const method = ["cash", "check", "card", "other"].includes(body.method) ? body.method : "cash";
    const upd = await markPaid(inv, method, "manual", null, String(body.note || "").slice(0, 200) || null);
    return json({ ok: true, invoice: upd });
  }

  if (action === "invoice_void") {
    const id = String(body.id || ""); const { data: inv } = await supabase.from("invoices").select("*").eq("id", id).eq("account_id", acct.id).maybeSingle();
    if (!inv) return json({ ok: false, error: "not_found" }, 404); if (inv.paid_at) return json({ ok: false, error: "already_paid" });
    const { data } = await supabase.from("invoices").update({ status: "void", updated_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
    return json({ ok: true, invoice: data });
  }

  if (action === "invoice_list") {
    const status = body.status ? String(body.status) : null; const limit = Math.min(200, Number(body.limit) || 50);
    let q = supabase.from("invoices").select("*").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(limit);
    if (status) q = q.eq("status", status);
    const { data } = await q; return json({ ok: true, invoices: (data || []).map((i: any) => ({ ...i, pay_url: payUrl(i.pay_token) })) });
  }

  if (action === "export_csv") {
    const from = body.from ? new Date(body.from) : new Date(Date.now() - 365 * 86400000); const to = body.to ? new Date(body.to) : new Date();
    const { data: invs } = await supabase.from("invoices").select("*").eq("account_id", acct.id).gte("created_at", from.toISOString()).lte("created_at", to.toISOString()).order("created_at");
    const { data: pays } = await supabase.from("payments").select("*, invoices(number)").eq("account_id", acct.id).gte("received_at", from.toISOString()).lte("received_at", to.toISOString()).order("received_at");
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const d = (v: any) => v ? new Date(v).toISOString().slice(0, 10) : "";
    const invCsv = ["Invoice No,Date,Customer,Phone,Email,Service Address,Description,Subtotal,Tax,Total,Status,Sent,Paid Date,Paid Method",
      ...(invs || []).map((i: any) => [i.number, d(i.created_at), i.customer_name, i.customer_phone, i.customer_email, i.service_address, (i.lines || []).map((l: any) => `${l.desc}${l.qty > 1 ? " x" + l.qty : ""} ${money(l.cents)}`).join("; "), (i.subtotal_cents / 100).toFixed(2), (i.tax_cents / 100).toFixed(2), (i.total_cents / 100).toFixed(2), i.status, d(i.sent_at), d(i.paid_at), i.paid_method].map(esc).join(","))].join("\n");
    const payCsv = ["Date,Invoice No,Amount,Method,Provider,Reference,Fee,Note",
      ...(pays || []).map((p: any) => [d(p.received_at), p.invoices?.number, (p.amount_cents / 100).toFixed(2), p.method, p.provider, p.provider_ref, p.fee_cents != null ? (p.fee_cents / 100).toFixed(2) : "", p.note].map(esc).join(","))].join("\n");
    return json({ ok: true, invoices_csv: invCsv, payments_csv: payCsv, count: { invoices: invs?.length || 0, payments: pays?.length || 0 } });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
