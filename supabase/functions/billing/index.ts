import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — platform billing v1. Sidekick Logistics bills each business for Donna through Stripe Billing
// (our own Stripe account, not Connect). Prices live in code below and are created in Stripe on first use
// by lookup key (donna_<family>_<tier>_<term>), so the same code sets up sandbox and live.
//
// Rules (agreed Nov 2026):
//   - Price list follows the Donna type: salon -> salon, contractor / property / real estate -> industry, else general.
//   - Card required up front. 14-day free trial that starts when Donna answers her first real call
//     (placeholder trial of 30 days at checkout, re-anchored to first call + 14 days by the sweep).
//   - Cancel any time during the trial: the plan ends when the trial does, nothing is charged.
//   - Month to month: cancel at period end. 1-year / 2-year: billing runs to the end of the commitment,
//     then the plan ends. Commitments renew for the same term unless cancelled.
//   - Extra minutes: 25c Starter / 20c Pro, added to the renewal invoice. A Starter bill never goes above
//     the Pro price for the same price list and term. Discounts apply to the plan price only.
//   - Plan ended (canceled / unpaid): Donna stops answering and calls forward to the business line
//     (retell-inbound checks billing_blocked). Past due keeps Donna answering while Stripe retries.
//   - account_billing.exempt = comped / test accounts, never billed or blocked.
//
// Actions (signed-in owner or admin):
//   status                        plan, usage this period, prices for this account, invoices
//   checkout {tier, term}          Stripe Checkout (subscription, card required, trial) -> {url}
//   confirm {session_id}           after Checkout returns: sync now instead of waiting for the webhook
//   change {tier?, term?}          upgrade / downgrade / commit (rules in change())
//   cancel / resume                schedule the end / undo it
//   card                          Stripe Checkout in setup mode to replace the card -> {url}
// Internal (x-cron-secret or service role):
//   sweep                         trial anchoring, commitment renewals, 80% / 100% usage emails, status sync
// Stripe webhook (any request with a stripe-signature header): the event is re-fetched from the Stripe API
// by id, so only real events from our account are acted on.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const APP = "https://donna-dashboard-three.vercel.app";
const STRIPE_VERSION = "2024-06-20";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, stripe-signature", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- price book (cents per month)
type Family = "general" | "salon" | "industry"; type Tier = "starter" | "pro"; type Term = "mtm" | "1y" | "2y";
const BOOK: Record<Family, Record<Tier, { minutes: number; price: Record<Term, number> }>> = {
  general:  { starter: { minutes: 300, price: { mtm: 5500,  "1y": 4900,  "2y": 4700 } },  pro: { minutes: 1200, price: { mtm: 16500, "1y": 14900, "2y": 14000 } } },
  salon:    { starter: { minutes: 400, price: { mtm: 8900,  "1y": 7900,  "2y": 7600 } },  pro: { minutes: 1200, price: { mtm: 21900, "1y": 19900, "2y": 18600 } } },
  industry: { starter: { minutes: 500, price: { mtm: 16500, "1y": 14900, "2y": 14000 } }, pro: { minutes: 1500, price: { mtm: 38500, "1y": 34900, "2y": 32700 } } },
};
const OVERAGE_CENTS: Record<Tier, number> = { starter: 25, pro: 20 };
const TERM_MONTHS: Record<Term, number> = { mtm: 0, "1y": 12, "2y": 24 };
const FAMILY_LABEL: Record<Family, string> = { general: "Everyday", salon: "Salon", industry: "Industry" };
const TERM_LABEL: Record<Term, string> = { mtm: "month to month", "1y": "1-year plan", "2y": "2-year plan" };
const TRIAL_DAYS = 14, TRIAL_PLACEHOLDER_DAYS = 30;
const isTier = (t: any): t is Tier => t === "starter" || t === "pro";
const isTerm = (t: any): t is Term => t === "mtm" || t === "1y" || t === "2y";
const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

const SALON_INDUSTRIES = new Set(["salon", "hair_salon", "nail_salon", "barbershop", "spa", "lash_brow"]);
const PRO_INDUSTRIES = new Set(["contractor", "property_management", "real_estate"]);
function familyFor(acct: any): Family {
  const f = acct?.settings?.features || {};
  const ind = String(acct?.industry || acct?.settings?.industry || "").toLowerCase();
  if (f.salon || SALON_INDUSTRIES.has(ind)) return "salon";
  if (f.real_estate || f.property_management || PRO_INDUSTRIES.has(ind)) return "industry";
  return "general";
}

// ---------------------------------------------------------------- Stripe (raw REST, pinned version)
let STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
let CRON = "";
async function loadSecrets() {
  if (STRIPE_KEY && CRON) return;
  const { data } = await supabase.from("app_secrets").select("key,value").in("key", ["stripe_secret_key", "cron_secret"]);
  const m = new Map((data || []).map((r: any) => [r.key, r.value || ""]));
  if (!STRIPE_KEY) STRIPE_KEY = m.get("stripe_secret_key") || "";
  CRON = m.get("cron_secret") || "";
}
function form(obj: any, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null) out.push(`${encodeURIComponent(key)}=`);
    else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? form(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)));
    else if (typeof v === "object") form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}
async function sp(method: "GET" | "POST" | "DELETE", path: string, params?: any, idem?: string): Promise<any> {
  await loadSecrets();
  if (!STRIPE_KEY) throw new Error("stripe_not_configured");
  const qs = params ? form(params).join("&") : "";
  const url = `https://api.stripe.com/v1${path}${method === "GET" && qs ? (path.includes("?") ? "&" : "?") + qs : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_KEY}`, "Stripe-Version": STRIPE_VERSION };
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idem) headers["Idempotency-Key"] = idem;
  const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : qs });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `stripe_${r.status}`);
  return j;
}
const lookupKey = (f: Family, t: Tier, term: Term) => `donna_${f}_${t}_${term}`;
const priceCache = new Map<string, string>();
async function priceId(f: Family, t: Tier, term: Term): Promise<string> {
  const lk = lookupKey(f, t, term);
  if (priceCache.has(lk)) return priceCache.get(lk)!;
  const found = await sp("GET", "/prices", { "lookup_keys[0]": lk, active: "true", limit: 1 });
  let id = found?.data?.[0]?.id as string | undefined;
  const want = BOOK[f][t].price[term];
  if (id && found.data[0].unit_amount !== want) id = undefined; // price changed in code: make a new one and move the lookup key
  if (!id) {
    const prodKey = `donna_${f}_${t}`;
    const prods = await sp("GET", "/products/search", { query: `metadata['donna_key']:'${prodKey}'` }).catch(() => ({ data: [] }));
    let prod = prods?.data?.[0]?.id;
    if (!prod) prod = (await sp("POST", "/products", { name: `Donna ${FAMILY_LABEL[f]} ${t === "pro" ? "Pro" : "Starter"}`, description: `${BOOK[f][t].minutes.toLocaleString()} minutes a month included`, metadata: { donna_key: prodKey } }, `prod-${prodKey}`)).id;
    const p = await sp("POST", "/prices", { product: prod, currency: "usd", unit_amount: want, recurring: { interval: "month" }, lookup_key: lk, transfer_lookup_key: "true", nickname: `${FAMILY_LABEL[f]} ${t} ${TERM_LABEL[term]}`, metadata: { family: f, tier: t, term } });
    id = p.id;
  }
  priceCache.set(lk, id!); return id!;
}

// ---------------------------------------------------------------- helpers
async function loadAccount(id: string) {
  const { data } = await supabase.from("accounts").select("id, name, industry, settings, status, plan").eq("id", id).maybeSingle();
  return data as any;
}
async function loadBilling(id: string) {
  const { data } = await supabase.from("account_billing").select("*").eq("account_id", id).maybeSingle();
  return (data as any) || null;
}
async function saveBilling(id: string, patch: any) {
  await supabase.from("account_billing").upsert({ account_id: id, ...patch, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
}
async function ownerContact(accountId: string) {
  const { data } = await supabase.from("users").select("email, full_name, phone").eq("account_id", accountId).eq("role", "owner").limit(1).maybeSingle();
  return (data as any) || {};
}
async function sendEmail(to: string[], subject: string, text: string) {
  const list = [...new Set(to.filter(Boolean))]; if (!RESEND_KEY || !list.length) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "Donna by Sidekick Logistics <donna@sidekicklogistics.com>", to: list, subject, text }) }); return r.ok; } catch { return false; }
}
function mapStatus(s: string): string {
  if (s === "trialing") return "trial";
  if (s === "active") return "active";
  if (s === "past_due") return "past_due";
  if (s === "unpaid" || s === "incomplete_expired") return "suspended";
  if (s === "canceled") return "cancelled";
  return "trial";
}
// Pull the subscription from Stripe and mirror it into account_billing + accounts.plan/status.
async function syncSub(accountId: string, subId: string) {
  const sub = await sp("GET", `/subscriptions/${subId}`, { "expand[0]": "default_payment_method" });
  const md = sub.metadata || {};
  const item = sub.items?.data?.[0];
  const pm = sub.default_payment_method?.card;
  const patch: any = {
    stripe_subscription_id: sub.id, stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    sub_status: sub.status, trial_end: iso(sub.trial_end),
    current_period_start: iso(sub.current_period_start ?? item?.current_period_start), current_period_end: iso(sub.current_period_end ?? item?.current_period_end),
    cancel_at: sub.cancel_at ? iso(sub.cancel_at) : (sub.cancel_at_period_end ? iso(sub.current_period_end ?? item?.current_period_end) : null),
    last_error: null,
  };
  const pmd = item?.price?.metadata || {};
  if (pmd.family) patch.family = pmd.family; else if (md.family) patch.family = md.family;
  if (pmd.tier) patch.tier = pmd.tier; else if (md.tier) patch.tier = md.tier;
  if (pmd.term) patch.term = pmd.term; else if (md.term) patch.term = md.term;
  if (pm) { patch.card_brand = pm.brand; patch.card_last4 = pm.last4; }
  // First time this subscription is seen (webhook or checkout return, whichever is first): fresh commitment,
  // counted from the first paid month, and the trial anchor / usage alerts reset.
  const before = await loadBilling(accountId);
  if (before?.stripe_subscription_id !== sub.id) {
    const term = (patch.term || md.term) as Term;
    const start = sub.trial_end ? new Date(sub.trial_end * 1000) : new Date();
    patch.commitment_ends_at = term && TERM_MONTHS[term] ? addMonths(start, TERM_MONTHS[term]).toISOString() : null;
    patch.trial_anchored_at = null; patch.alert80_period = null; patch.alert100_period = null;
  }
  await saveBilling(accountId, patch);
  const acctPatch: any = { status: mapStatus(sub.status) };
  if (patch.tier) acctPatch.plan = patch.tier;
  await supabase.from("accounts").update(acctPatch).eq("id", accountId);
  return { sub, patch };
}
async function usage(accountId: string, from: string | null, to?: string | null) {
  if (!from) return 0;
  const { data } = await supabase.rpc("billable_minutes", { p_account: accountId, p_from: from, p_to: to || new Date().toISOString() });
  return Number(data || 0);
}
// Overage for a period, with the Starter cap at the Pro price of the same price list and term.
function overage(f: Family, t: Tier, term: Term, minutes: number) {
  const inc = BOOK[f][t].minutes; const extra = Math.max(0, minutes - inc);
  let cents = extra * OVERAGE_CENTS[t]; let capped = false;
  if (t === "starter") { const room = BOOK[f].pro.price[term] - BOOK[f].starter.price[term]; if (cents > room) { cents = room; capped = true; } }
  return { included: inc, extra, cents, capped };
}

// ---------------------------------------------------------------- caller
async function caller(req: Request) {
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth) return null;
  const uc = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await uc.auth.getUser(auth); if (!user) return null;
  const { data: u } = await supabase.from("users").select("id, account_id, role, email, full_name").eq("id", user.id).maybeSingle();
  if (!u) return null;
  return { ...(u as any), email: (u as any).email || user.email };
}
const canManage = (u: any) => u && (u.role === "owner" || u.role === "admin");

// ---------------------------------------------------------------- actions
async function status(u: any) {
  const acct = await loadAccount(u.account_id); const b = await loadBilling(u.account_id);
  const family: Family = (b?.family as Family) || familyFor(acct);
  const prices = { family, label: FAMILY_LABEL[family], overage: OVERAGE_CENTS, tiers: BOOK[family] };
  const out: any = { ok: true, exempt: !!b?.exempt, can_manage: canManage(u), prices, billing: null, usage: null, invoices: [] };
  if (!b || !b.stripe_subscription_id) return out;
  out.billing = { tier: b.tier, term: b.term, family: b.family, sub_status: b.sub_status, trial_end: b.trial_end, trial_anchored: !!b.trial_anchored_at, current_period_start: b.current_period_start, current_period_end: b.current_period_end, commitment_ends_at: b.commitment_ends_at, cancel_at: b.cancel_at, card_brand: b.card_brand, card_last4: b.card_last4, price_cents: b.family && b.tier && b.term ? BOOK[b.family as Family][b.tier as Tier].price[b.term as Term] : null };
  if (b.sub_status !== "trialing" && b.family && b.tier && b.term) {
    const used = await usage(u.account_id, b.current_period_start);
    out.usage = { minutes: used, ...overage(b.family, b.tier, b.term, used), rate: OVERAGE_CENTS[b.tier as Tier] };
  } else if (b.sub_status === "trialing") {
    out.usage = { minutes: await usage(u.account_id, b.created_at), trial: true, included: b.tier && b.family ? BOOK[b.family as Family][b.tier as Tier].minutes : null };
  }
  if (canManage(u) && b.stripe_customer_id) {
    try {
      const inv = await sp("GET", "/invoices", { customer: b.stripe_customer_id, limit: 12 });
      out.invoices = (inv.data || []).filter((i: any) => i.status !== "draft").map((i: any) => ({ id: i.id, number: i.number, created: iso(i.created), total: i.total, status: i.status, url: i.hosted_invoice_url, pdf: i.invoice_pdf }));
    } catch (e) { out.invoices_error = String((e as any)?.message || e); }
  }
  return out;
}

async function checkout(u: any, body: any) {
  if (!canManage(u)) return { ok: false, error: "owner_only" };
  const tier = body.tier, term = body.term; if (!isTier(tier) || !isTerm(term)) return { ok: false, error: "bad_plan" };
  const acct = await loadAccount(u.account_id); const b = await loadBilling(u.account_id);
  if (b?.exempt) return { ok: false, error: "exempt" };
  if (b?.stripe_subscription_id && !["canceled", "incomplete_expired"].includes(String(b.sub_status))) return { ok: false, error: "already_subscribed" };
  const family = familyFor(acct);
  let customer = b?.stripe_customer_id;
  if (!customer) {
    const c = await sp("POST", "/customers", { name: acct?.name || undefined, email: u.email || undefined, metadata: { account_id: u.account_id } }, `cus-${u.account_id}`);
    customer = c.id; await saveBilling(u.account_id, { stripe_customer_id: customer, family });
  }
  // First subscription gets the trial; someone coming back after cancelling does not.
  const hadTrial = !!b?.trial_end;
  const sess = await sp("POST", "/checkout/sessions", {
    mode: "subscription", customer, client_reference_id: u.account_id,
    line_items: [{ price: await priceId(family, tier, term), quantity: 1 }],
    payment_method_collection: "always",
    subscription_data: { ...(hadTrial ? {} : { trial_period_days: TRIAL_PLACEHOLDER_DAYS, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } }), metadata: { account_id: u.account_id, family, tier, term } },
    metadata: { account_id: u.account_id, family, tier, term, kind: "subscribe" },
    custom_text: { submit: { message: hadTrial ? `Donna ${tier === "pro" ? "Pro" : "Starter"}, ${TERM_LABEL[term]}.` : `No charge today. Your 14 free days start when Donna answers her first real call. Cancel any time before then and you won't be charged.` } },
    success_url: `${APP}/?billing=success&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP}/?billing=cancelled`,
  });
  return { ok: true, url: sess.url };
}

async function confirm(u: any, body: any) {
  const sid = String(body.session_id || ""); if (!sid.startsWith("cs_")) return { ok: false, error: "bad_session" };
  const s = await sp("GET", `/checkout/sessions/${sid}`);
  if (s.client_reference_id !== u.account_id && s.metadata?.account_id !== u.account_id) return { ok: false, error: "not_yours" };
  await onCheckoutDone(s);
  return { ok: true, ...(await status(u)) };
}

async function onCheckoutDone(s: any) {
  const acctId = s.metadata?.account_id || s.client_reference_id; if (!acctId) return;
  if (s.mode === "setup") {
    const si = await sp("GET", `/setup_intents/${s.setup_intent}`);
    const b = await loadBilling(acctId); if (!b?.stripe_customer_id || !si.payment_method) return;
    await sp("POST", `/customers/${b.stripe_customer_id}`, { invoice_settings: { default_payment_method: si.payment_method } });
    if (b.stripe_subscription_id) { await sp("POST", `/subscriptions/${b.stripe_subscription_id}`, { default_payment_method: si.payment_method }); await syncSub(acctId, b.stripe_subscription_id); }
    return;
  }
  if (s.mode !== "subscription" || !s.subscription) return;
  const subId = typeof s.subscription === "string" ? s.subscription : s.subscription.id;
  const { sub } = await syncSub(acctId, subId); // a new subscription gets its commitment set inside syncSub
  // Card from Checkout becomes the customer's default too (used for renewals and overage).
  if (sub.default_payment_method) { const pmId = typeof sub.default_payment_method === "string" ? sub.default_payment_method : sub.default_payment_method.id; await sp("POST", `/customers/${sub.customer}`, { invoice_settings: { default_payment_method: pmId } }).catch(() => {}); }
}

async function change(u: any, body: any) {
  if (!canManage(u)) return { ok: false, error: "owner_only" };
  const b = await loadBilling(u.account_id);
  if (!b?.stripe_subscription_id || ["canceled", "incomplete_expired"].includes(String(b.sub_status))) return { ok: false, error: "no_plan" };
  const tier: Tier = isTier(body.tier) ? body.tier : b.tier; const term: Term = isTerm(body.term) ? body.term : b.term;
  if (tier === b.tier && term === b.term) return { ok: true, unchanged: true };
  const committed = b.commitment_ends_at && new Date(b.commitment_ends_at) > new Date() && b.term !== "mtm";
  if (committed && tier === "starter" && b.tier === "pro") return { ok: false, error: "committed_downgrade", until: b.commitment_ends_at };
  if (committed && TERM_MONTHS[term] < TERM_MONTHS[b.term as Term]) return { ok: false, error: "committed_shorter", until: b.commitment_ends_at };
  const sub = await sp("GET", `/subscriptions/${b.stripe_subscription_id}`);
  const item = sub.items.data[0];
  await sp("POST", `/subscriptions/${sub.id}`, { items: [{ id: item.id, price: await priceId(b.family, tier, term) }], proration_behavior: sub.status === "trialing" ? "none" : "create_prorations", metadata: { ...sub.metadata, tier, term } });
  const patch: any = {};
  if (term !== b.term) {
    // A new or longer commitment starts now (or when the trial ends).
    const start = sub.status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000) : new Date();
    patch.commitment_ends_at = TERM_MONTHS[term] ? addMonths(start, TERM_MONTHS[term]).toISOString() : null;
  }
  if (Object.keys(patch).length) await saveBilling(u.account_id, patch);
  await syncSub(u.account_id, sub.id);
  return { ok: true, ...(await status(u)) };
}

async function cancel(u: any) {
  if (!canManage(u)) return { ok: false, error: "owner_only" };
  const b = await loadBilling(u.account_id); if (!b?.stripe_subscription_id) return { ok: false, error: "no_plan" };
  const sub = await sp("GET", `/subscriptions/${b.stripe_subscription_id}`);
  let endsAt: number;
  if (sub.status === "trialing" && sub.trial_end) endsAt = sub.trial_end; // ends with the trial, nothing charged
  else {
    const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    const commit = b.commitment_ends_at ? Math.floor(new Date(b.commitment_ends_at).getTime() / 1000) : 0;
    endsAt = Math.max(periodEnd, commit);
  }
  await sp("POST", `/subscriptions/${sub.id}`, { cancel_at: endsAt, proration_behavior: "none" });
  await syncSub(u.account_id, sub.id);
  const o = await ownerContact(u.account_id); const acct = await loadAccount(u.account_id);
  await sendEmail([o.email, u.email], "Your Donna plan is set to end", `Hi${o.full_name ? " " + String(o.full_name).split(" ")[0] : ""},\n\nYour Donna plan for ${acct?.name || "your business"} will end on ${new Date(endsAt * 1000).toDateString()}.${sub.status === "trialing" ? " You're still in your free trial, so you won't be charged." : ""} Donna keeps answering until then.\n\nChanged your mind? Open Billing in your Donna dashboard and choose Keep my plan.\n\nDonna by Sidekick Logistics`);
  return { ok: true, ...(await status(u)) };
}
async function resume(u: any) {
  if (!canManage(u)) return { ok: false, error: "owner_only" };
  const b = await loadBilling(u.account_id); if (!b?.stripe_subscription_id) return { ok: false, error: "no_plan" };
  await sp("POST", `/subscriptions/${b.stripe_subscription_id}`, { cancel_at: "", cancel_at_period_end: "false" });
  await syncSub(u.account_id, b.stripe_subscription_id);
  return { ok: true, ...(await status(u)) };
}
async function card(u: any) {
  if (!canManage(u)) return { ok: false, error: "owner_only" };
  const b = await loadBilling(u.account_id); if (!b?.stripe_customer_id) return { ok: false, error: "no_plan" };
  const s = await sp("POST", "/checkout/sessions", { mode: "setup", customer: b.stripe_customer_id, currency: "usd", payment_method_types: ["card"], client_reference_id: u.account_id, metadata: { account_id: u.account_id, kind: "card" }, success_url: `${APP}/?billing=card&session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP}/?billing=cancelled` });
  return { ok: true, url: s.url };
}

// ---------------------------------------------------------------- webhook
async function accountForSub(sub: any): Promise<string | null> {
  if (sub?.metadata?.account_id) return sub.metadata.account_id;
  const { data } = await supabase.from("account_billing").select("account_id").eq("stripe_subscription_id", sub.id).maybeSingle();
  return (data as any)?.account_id || null;
}
// Newer Stripe API versions moved invoice.subscription to invoice.parent.subscription_details.subscription.
const invSub = (inv: any): string | null => { const s = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null; return s ? (typeof s === "string" ? s : s.id) : null; };
async function onInvoiceCreated(inv: any) {
  // Only renewals: the invoice covers the period that just ended, which is when extra minutes are billed.
  const subId = invSub(inv);
  if (inv.billing_reason !== "subscription_cycle" || inv.status !== "draft" || !subId) return;
  const { data: done } = await supabase.from("billing_overages").select("invoice_id").eq("invoice_id", inv.id).maybeSingle(); if (done) return;
  const { data: b } = await supabase.from("account_billing").select("*").eq("stripe_subscription_id", subId).maybeSingle();
  const bill: any = b; if (!bill || bill.exempt || !bill.family || !bill.tier || !bill.term) return;
  const from = iso(inv.period_start)!, to = iso(inv.period_end)!;
  // The trial is free: a period that ended at or before the trial end has no overage.
  if (bill.trial_end && new Date(to) <= new Date(new Date(bill.trial_end).getTime() + 60000)) return;
  const minutes = await usage(bill.account_id, from, to);
  const o = overage(bill.family, bill.tier, bill.term, minutes);
  let itemId: string | null = null;
  if (o.cents > 0) {
    const ii = await sp("POST", "/invoiceitems", { customer: inv.customer, invoice: inv.id, amount: o.cents, currency: "usd", description: `Extra minutes: ${o.extra.toLocaleString()} over ${o.included.toLocaleString()} included at ${OVERAGE_CENTS[bill.tier as Tier]} cents each${o.capped ? " (capped at the Pro price)" : ""}`, metadata: { account_id: bill.account_id, minutes: String(minutes) } }, `ovg-${inv.id}`);
    itemId = ii.id;
  }
  await supabase.from("billing_overages").insert({ invoice_id: inv.id, account_id: bill.account_id, period_start: from, period_end: to, minutes, included: o.included, extra_minutes: o.extra, cents: o.cents, capped: o.capped, invoice_item_id: itemId });
}
async function onWebhook(req: Request) {
  let raw: any = {}; try { raw = await req.json(); } catch { return json({ ok: false }, 400); }
  if (!raw?.id || !String(raw.id).startsWith("evt_")) return json({ ok: false }, 400);
  if (raw.account) return json({ ok: true, ignored: "connect" }); // Connect events belong to the payments function
  let ev: any; try { ev = await sp("GET", `/events/${raw.id}`); } catch { return json({ ok: false, error: "unknown_event" }, 400); }
  const { error: dup } = await supabase.from("billing_events").insert({ id: ev.id, type: ev.type });
  if (dup) return json({ ok: true, duplicate: true });
  const o = ev.data?.object || {};
  try {
    if (ev.type === "checkout.session.completed" && (o.metadata?.kind === "subscribe" || o.metadata?.kind === "card")) await onCheckoutDone(o);
    else if (ev.type.startsWith("customer.subscription.")) { const a = await accountForSub(o); if (a) { const b = await loadBilling(a); if (!b?.stripe_subscription_id || b.stripe_subscription_id === o.id) await syncSub(a, o.id); } }
    else if (ev.type === "invoice.created") await onInvoiceCreated(o);
    else if (ev.type === "invoice.payment_failed" && invSub(o)) {
      const { data: b } = await supabase.from("account_billing").select("account_id").eq("stripe_subscription_id", invSub(o)).maybeSingle();
      const a = (b as any)?.account_id; if (a) { await syncSub(a, invSub(o)!); const c = await ownerContact(a); await sendEmail([c.email], "Donna: your payment didn't go through", `Hi${c.full_name ? " " + String(c.full_name).split(" ")[0] : ""},\n\nWe couldn't charge your card for Donna (${money(o.amount_due)}). Stripe will try again over the next few days, and Donna keeps answering in the meantime.\n\nUpdate your card: open Billing in your Donna dashboard and choose Update card.\n${o.hosted_invoice_url ? "Or pay the invoice here: " + o.hosted_invoice_url + "\n" : ""}\nDonna by Sidekick Logistics`); }
    }
    else if (ev.type === "invoice.paid" && invSub(o)) { const { data: b } = await supabase.from("account_billing").select("account_id").eq("stripe_subscription_id", invSub(o)).maybeSingle(); if ((b as any)?.account_id) await syncSub((b as any).account_id, invSub(o)!); }
  } catch (e) {
    await supabase.from("billing_events").delete().eq("id", ev.id); // let Stripe retry
    console.error("billing webhook", ev.type, String((e as any)?.message || e));
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
  return json({ ok: true, type: ev.type });
}

// ---------------------------------------------------------------- sweep
async function sweep() {
  const out = { anchored: 0, renewed: 0, alerts: 0, synced: 0, errors: [] as string[] };
  const { data: rows } = await supabase.from("account_billing").select("*").eq("exempt", false).not("stripe_subscription_id", "is", null).limit(500);
  for (const b of (rows || []) as any[]) {
    try {
      // 1. Trial starts at the first real call (30 seconds or more, not spam): trial end = that call + 14 days.
      if (b.sub_status === "trialing" && !b.trial_anchored_at) {
        const { data: c } = await supabase.from("calls").select("started_at").eq("account_id", b.account_id).gte("started_at", b.created_at).not("is_spam", "is", true).gte("duration_seconds", 30).order("started_at", { ascending: true }).limit(1).maybeSingle();
        if (c) {
          const end = Math.floor(new Date((c as any).started_at).getTime() / 1000) + TRIAL_DAYS * 86400;
          const curEnd = b.trial_end ? Math.floor(new Date(b.trial_end).getTime() / 1000) : 0;
          if (end !== curEnd) {
            // A first call more than 14 days ago (sweep was behind) ends the trial now.
            const soon = end <= Math.floor(Date.now() / 1000) + 300;
            await sp("POST", `/subscriptions/${b.stripe_subscription_id}`, { trial_end: soon ? "now" : end, proration_behavior: "none", ...(b.cancel_at && !soon ? { cancel_at: end } : {}) });
          }
          const patch: any = { trial_anchored_at: (c as any).started_at };
          if (b.term && b.term !== "mtm") patch.commitment_ends_at = addMonths(new Date(end * 1000), TERM_MONTHS[b.term as Term]).toISOString();
          await saveBilling(b.account_id, patch); await syncSub(b.account_id, b.stripe_subscription_id); out.anchored++;
          continue;
        }
      }
      // 2. Commitments renew for the same term unless the plan is set to end.
      if (b.commitment_ends_at && b.term && b.term !== "mtm" && !b.cancel_at && new Date(b.commitment_ends_at) <= new Date() && ["active", "past_due"].includes(b.sub_status)) {
        await saveBilling(b.account_id, { commitment_ends_at: addMonths(new Date(b.commitment_ends_at), TERM_MONTHS[b.term as Term]).toISOString() }); out.renewed++;
      }
      // 3. Usage emails at 80% and 100% of included minutes, once per period.
      if (b.sub_status === "active" && b.family && b.tier && b.current_period_start) {
        const used = await usage(b.account_id, b.current_period_start);
        const inc = BOOK[b.family as Family][b.tier as Tier].minutes; const pct = used / inc;
        const key = b.current_period_start;
        const sendFor = pct >= 1 && b.alert100_period !== key ? 100 : (pct >= 0.8 && b.alert80_period !== key && b.alert100_period !== key ? 80 : 0);
        if (sendFor) {
          const acct = await loadAccount(b.account_id); const c = await ownerContact(b.account_id);
          const alertEmail = acct?.settings?.alert_email;
          const t = b.tier as Tier;
          const msg = sendFor === 100
            ? `Donna has used all ${inc.toLocaleString()} included minutes this period (${used.toLocaleString()} so far). She keeps answering every call. Extra minutes are ${OVERAGE_CENTS[t]}c each${t === "starter" ? `, and your bill never goes above the Pro price (${money(BOOK[b.family as Family].pro.price[b.term as Term])})` : ""}.`
            : `Donna has used ${used.toLocaleString()} of your ${inc.toLocaleString()} included minutes this period (${Math.round(pct * 100)}%). Nothing changes: she keeps answering. Extra minutes would be ${OVERAGE_CENTS[t]}c each.`;
          await sendEmail([c.email, alertEmail], `Donna: ${sendFor}% of your minutes used`, `Hi${c.full_name ? " " + String(c.full_name).split(" ")[0] : ""},\n\n${msg}\n\nYour period renews on ${b.current_period_end ? new Date(b.current_period_end).toDateString() : "your next billing date"}.${t === "starter" ? " If you're busy every month, Pro includes more minutes and your whole team." : ""}\n\nDonna by Sidekick Logistics`);
          await saveBilling(b.account_id, sendFor === 100 ? { alert100_period: key, alert80_period: key } : { alert80_period: key }); out.alerts++;
        }
      }
      // 4. Keep the mirror honest if a webhook was missed (every row, once an hour).
      if (!b.updated_at || Date.now() - new Date(b.updated_at).getTime() > 3600_000) { await syncSub(b.account_id, b.stripe_subscription_id); out.synced++; }
    } catch (e) { out.errors.push(`${b.account_id}: ${String((e as any)?.message || e)}`); await saveBilling(b.account_id, { last_error: String((e as any)?.message || e).slice(0, 300) }); }
  }
  return out;
}

// ---------------------------------------------------------------- serve
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (req.headers.get("stripe-signature")) return await onWebhook(req);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "");
  try {
    await loadSecrets();
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const cronHdr = req.headers.get("x-cron-secret") || "";
    const internal = auth === SERVICE_ROLE || (!!cronHdr && cronHdr === CRON);
    if (action === "sweep") { if (!internal) return json({ ok: false, error: "internal_only" }, 403); return json({ ok: true, ...(await sweep()) }); }
    if (action === "prices") { if (!internal) return json({ ok: false, error: "internal_only" }, 403); const ids: any = {}; for (const f of Object.keys(BOOK) as Family[]) for (const t of ["starter", "pro"] as Tier[]) for (const term of ["mtm", "1y", "2y"] as Term[]) ids[lookupKey(f, t, term)] = await priceId(f, t, term); return json({ ok: true, prices: ids }); }
    const u = await caller(req); if (!u) return json({ ok: false, error: "unauthorized" }, 401);
    if (action === "status") return json(await status(u));
    if (action === "checkout") return json(await checkout(u, body));
    if (action === "confirm") return json(await confirm(u, body));
    if (action === "change") return json(await change(u, body));
    if (action === "cancel") return json(await cancel(u));
    if (action === "resume") return json(await resume(u));
    if (action === "card") return json(await card(u));
    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    console.error("billing", action, String((e as any)?.message || e));
    return json({ ok: false, error: String((e as any)?.message || e) }, 500);
  }
});
