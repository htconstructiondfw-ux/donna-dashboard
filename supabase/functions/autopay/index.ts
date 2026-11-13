import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna: autopay for repeat services (v2: cards get a Stripe customer so they can be charged later; v1). Contractor Donna (recurring_jobs) and Junior Donna (junior_customers).
//
// The business sets the price on the repeating job. Donna never prices a job and never holds money: every charge is made on
// the business's own Stripe account (for Junior, the parent's), through the shared `payments` module (card on file on the client).
// The customer agrees once on a page that says who charges, what for, how much and when, and can turn it off from the same link.
// Junior: only the parent login can ask a customer for autopay; a kid's request waits for the parent.
//
// Signed-in:  request {recurring_id | junior_customer_id}   -> text + email the customer the agreement link (kid -> needs_parent)
//             approve {junior_customer_id}                  -> parent OKs a kid's request
//             off {recurring_id | junior_customer_id}       -> business (or parent, or kid) turns it off
// Public:     view {token} | card {token} (Stripe link to save a card) | agree {token} | stop {token}
// Internal:   sweep  -> heads-up before the first charged visit; charge finished visits; pay link when a charge fails

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
const nowIso = () => new Date().toISOString();
const link = (token: string) => `${APP}/autopay/${token}`;
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, "0")).join("");
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());
const FREQ: Record<string, string> = { weekly: "every week", biweekly: "every two weeks", every_2_weeks: "every two weeks", monthly: "every month", quarterly: "every three months", yearly: "every year" };

let STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
async function stripeKey(): Promise<string> { if (STRIPE_KEY) return STRIPE_KEY; try { const { data } = await supabase.from("app_secrets").select("value").eq("key", "stripe_secret_key").maybeSingle(); STRIPE_KEY = String((data as any)?.value || "").trim(); } catch { /* */ } return STRIPE_KEY; }
async function stripeV1(method: "GET" | "POST", path: string, form: Record<string, string> | null, stripeAccount: string): Promise<any> {
  const key = await stripeKey(); if (!key) throw new Error("stripe_not_configured");
  const h: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20", "Stripe-Account": stripeAccount };
  if (method === "POST") h["Content-Type"] = "application/x-www-form-urlencoded";
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers: h, body: method === "POST" ? new URLSearchParams(form || {}).toString() : undefined });
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
async function loadAccount(id: string) { const { data } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", id).maybeSingle(); return data as any; }
async function loadPA(id: string) { const { data } = await supabase.from("payment_accounts").select("stripe_account_id, charges_enabled").eq("account_id", id).maybeSingle(); return data as any; }
async function owner(accountId: string): Promise<any> { const { data } = await supabase.from("users").select("id, phone, email, full_name").eq("account_id", accountId).eq("role", "owner").order("created_at").limit(1).maybeSingle(); return data as any; }
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  const num = normPhone(to); if (!num) return false;
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to: num, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
async function sendEmail(to: string, business: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: `${business} via Donna <donna@sidekicklogistics.com>`, to: [to], subject, text }) }); return r.ok; } catch { return false; }
}
// Tell the customer: text when texting is on, email when there is an address.
async function tell(acct: any, t: Target, text: string, subject: string): Promise<boolean> {
  let ok = false;
  if (t.phone && acct?.settings?.sms?.enabled === true) ok = (await sendText(acct.id, t.phone, `${acct.name}: ${text}`)) || ok;
  if (t.email) ok = (await sendEmail(t.email, acct.name, subject, `Hi${t.name ? " " + t.name.split(/\s+/)[0] : ""},\n\n${text}\n\n${acct.name}`)) || ok;
  return ok;
}
async function tellOwner(acct: any, text: string) { const o = await owner(acct.id); if (o?.phone && acct?.settings?.sms?.enabled === true) await sendText(acct.id, o.phone, `${acct.name}: ${text}`); else if (o?.email) await sendEmail(o.email, acct.name, "Autopay update", text); }
const pay = async (b: any, userId: string) => { const r = await fetch(`${SELF}/payments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ ...b, user_id: userId }) }); return await r.json().catch(() => ({})); };

// ---------------------------------------------------------------- the thing autopay is attached to
type Target = { kind: "recurring" | "junior"; id: string; account_id: string; autopay: any; contact_id: string | null; name: string; phone: string; email: string; what: string; price_cents: number; freq: string };
const linesTotal = (lines: any): number => (Array.isArray(lines) ? lines : []).reduce((t: number, l: any) => t + (l?.cents != null ? Math.round(Number(l.cents) || 0) : Math.round((Number(l?.qty ?? 1) || 1) * (Number(l?.unit_cents) || 0))), 0);
function fromRecurring(r: any): Target { return { kind: "recurring", id: r.id, account_id: r.account_id, autopay: r.autopay || null, contact_id: r.contact_id || null, name: r.customer_name || "", phone: normPhone(r.customer_phone || ""), email: String(r.customer_email || "").trim(), what: r.title || "your regular service", price_cents: linesTotal(r.lines), freq: FREQ[String(r.frequency || "")] || "" }; }
function fromJunior(c: any): Target { return { kind: "junior", id: c.id, account_id: c.account_id, autopay: c.autopay || null, contact_id: c.contact_id || null, name: c.name || "", phone: normPhone(c.phone || ""), email: String(c.email || "").trim(), what: "repeat jobs", price_cents: 0, freq: "" }; }
async function loadTarget(by: { recurring_id?: string; junior_customer_id?: string; token?: string }, accountId?: string): Promise<Target | null> {
  if (by.recurring_id) { let q = supabase.from("recurring_jobs").select("*").eq("id", by.recurring_id); if (accountId) q = q.eq("account_id", accountId); const { data } = await q.maybeSingle(); return data ? fromRecurring(data) : null; }
  if (by.junior_customer_id) { let q = supabase.from("junior_customers").select("*").eq("id", by.junior_customer_id); if (accountId) q = q.eq("account_id", accountId); const { data } = await q.maybeSingle(); return data ? fromJunior(data) : null; }
  if (by.token) {
    const { data: r } = await supabase.from("recurring_jobs").select("*").eq("autopay->>token", by.token).maybeSingle(); if (r) return fromRecurring(r);
    const { data: c } = await supabase.from("junior_customers").select("*").eq("autopay->>token", by.token).maybeSingle(); if (c) return fromJunior(c);
  }
  return null;
}
async function saveAutopay(t: Target, patch: Record<string, unknown>): Promise<any> {
  const ap = { ...(t.autopay || {}), ...patch }; t.autopay = ap;
  await supabase.from(t.kind === "recurring" ? "recurring_jobs" : "junior_customers").update({ autopay: ap, updated_at: nowIso() }).eq("id", t.id);
  return ap;
}
// Card on file lives on the client record (contacts.card). Make sure the target has one to hang it on.
async function ensureContact(t: Target): Promise<string | null> {
  if (t.contact_id) return t.contact_id;
  let id: string | null = null;
  if (t.phone) { const { data } = await supabase.from("contacts").select("id").eq("account_id", t.account_id).eq("phone", t.phone).limit(1).maybeSingle(); id = (data as any)?.id || null; }
  if (!id) { const { data } = await supabase.from("contacts").insert({ account_id: t.account_id, name: t.name || null, phone: t.phone || null, email: t.email || null }).select("id").maybeSingle(); id = (data as any)?.id || null; }
  if (id) { await supabase.from(t.kind === "recurring" ? "recurring_jobs" : "junior_customers").update({ contact_id: id, updated_at: nowIso() }).eq("id", t.id); t.contact_id = id; }
  return id;
}
async function cardOf(t: Target): Promise<any> { if (!t.contact_id) return null; const { data } = await supabase.from("contacts").select("card").eq("id", t.contact_id).maybeSingle(); const c = (data as any)?.card; return c?.payment_method ? c : null; }
// Stripe only lets a saved card be charged later when it belongs to a Stripe customer. Make one (on the business's account) when missing.
async function stripeCustomer(t: Target, pa: any): Promise<string | null> {
  if (t.autopay?.stripe_customer) return t.autopay.stripe_customer;
  try { const f: Record<string, string> = { "metadata[contact_id]": String(t.contact_id || ""), "metadata[account_id]": t.account_id }; if (t.name) f.name = t.name; if (t.email) f.email = t.email; if (t.phone) f.phone = t.phone;
    const c: any = await stripeV1("POST", "/v1/customers", f, pa.stripe_account_id); await saveAutopay(t, { stripe_customer: c.id }); return c.id; } catch (e) { console.error("stripeCustomer", String(e)); return null; }
}
async function ensureCustomer(t: Target, pa: any): Promise<any> {
  const card = await cardOf(t); if (!card || card.customer || !pa?.stripe_account_id) return card;
  try { const cust = await stripeCustomer(t, pa); if (!cust) return card;
    await stripeV1("POST", `/v1/payment_methods/${card.payment_method}/attach`, { customer: cust }, pa.stripe_account_id);
    const fixed = { ...card, customer: cust }; await supabase.from("contacts").update({ card: fixed, updated_at: nowIso() }).eq("id", t.contact_id); return fixed;
  } catch (e) { console.error("ensureCustomer", String(e)); return card; }
}
// The customer came back from Stripe before the webhook landed: read the setup session and keep the card ourselves.
async function pullCard(t: Target, pa: any): Promise<any> {
  const sid = t.autopay?.setup_session; if (!sid || !pa?.stripe_account_id || !t.contact_id) return null;
  try {
    const cs: any = await stripeV1("GET", `/v1/checkout/sessions/${sid}?expand[]=setup_intent.payment_method`, null, pa.stripe_account_id);
    const pm = cs?.setup_intent?.payment_method; if (cs.status !== "complete" || !pm?.id) return null;
    const card = { payment_method: pm.id, customer: (typeof cs.customer === "string" ? cs.customer : cs.customer?.id) || t.autopay?.stripe_customer || null, brand: pm.card?.brand || null, last4: pm.card?.last4 || null, saved_at: nowIso() };
    await supabase.from("contacts").update({ card, updated_at: nowIso() }).eq("id", t.contact_id); return card;
  } catch (e) { console.error("pullCard", String(e)); return null; }
}
async function juniorJobs(t: Target): Promise<any[]> { const { data } = await supabase.from("junior_jobs").select("title, price_cents, repeat, job_date").eq("customer_id", t.id).eq("status", "scheduled").neq("repeat", "none").order("job_date").limit(5); return data || []; }
function priceWords(t: Target, jj: any[]): string {
  if (t.kind === "recurring") return `${money(t.price_cents)} per visit${t.freq ? ", " + t.freq : ""}`;
  const seen = new Set<string>(); const parts: string[] = []; for (const j of jj) { const k = `${j.title}|${j.price_cents}`; if (seen.has(k) || !(j.price_cents > 0)) continue; seen.add(k); parts.push(`${j.title} ${money(j.price_cents)}`); }
  return parts.length ? parts.join(", ") + " (each time the job is done)" : "the price agreed for each job, each time it is done";
}
async function sendAsk(acct: any, t: Target): Promise<boolean> {
  const jj = t.kind === "junior" ? await juniorJobs(t) : [];
  return await tell(acct, t, `Would you like to pay automatically for ${t.what}? ${priceWords(t, jj)}. Your card is charged only after each visit is done, you get a receipt every time, and you can turn it off any time. Set it up here: ${link(t.autopay.token)}`, "Set up automatic payment");
}

// ---------------------------------------------------------------- sweep
async function sweep(only?: string): Promise<any> {
  const out: any = { ok: true, charged: 0, failed: 0, heads_up: 0, skipped: 0, errors: [] as string[] };
  const since = new Date(Date.now() - 7 * 86400000).toISOString(); const settle = new Date(Date.now() - 10 * 60000).toISOString();
  const accts: Record<string, any> = {}; const pas: Record<string, any> = {}; const owners: Record<string, any> = {};
  const ctx = async (accountId: string) => { if (!accts[accountId]) { accts[accountId] = await loadAccount(accountId); pas[accountId] = await loadPA(accountId); owners[accountId] = await owner(accountId); } return { acct: accts[accountId], pa: pas[accountId], own: owners[accountId] }; };
  const live = (acct: any, pa: any) => acct?.settings?.payments?.enabled === true && pa?.charges_enabled === true;
  const chargeInvoice = async (acct: any, own: any, t: Target, invId: string, label: string): Promise<boolean> => {
    await ensureCustomer(t, pas[t.account_id]);
    const c: any = await pay({ action: "invoice_charge_card", id: invId }, own.id);
    if (c?.ok) { out.charged++; await saveAutopay(t, { last_charge_at: nowIso(), first_charge_at: t.autopay?.first_charge_at || nowIso(), last_error: null }); return true; }
    out.failed++;
    await pay({ action: "invoice_send", id: invId }, own.id);                 // one try only; the pay link goes out instead
    await saveAutopay(t, { last_error: String(c?.message || c?.error || "charge failed").slice(0, 200), last_error_at: nowIso() });
    await tellOwner(acct, `Autopay did not go through for ${t.name || "a customer"} (${label}). Donna sent them a pay link instead.`);
    return false;
  };

  // Contractor: finished visits of repeating jobs with autopay on.
  let rq = supabase.from("recurring_jobs").select("*").eq("autopay->>status", "on"); if (only) rq = rq.eq("account_id", only);
  const { data: recs } = await rq.limit(1000);
  for (const r of recs || []) {
    const t = fromRecurring(r); const { acct, pa, own } = await ctx(t.account_id); if (!acct || !own || !live(acct, pa)) { out.skipped++; continue; }
    try {
      // Heads-up once, before the first charged visit.
      if (!t.autopay.heads_up_at && !t.autopay.first_charge_at) {
        const { data: nxt } = await supabase.from("jobs").select("scheduled_at").eq("recurring_id", t.id).is("done_at", null).gte("scheduled_at", nowIso()).lte("scheduled_at", new Date(Date.now() + 36 * 3600000).toISOString()).order("scheduled_at").limit(1).maybeSingle();
        if (nxt) { const card = await cardOf(t); const when = new Intl.DateTimeFormat("en-US", { timeZone: acct.settings?.timezone || "America/Chicago", weekday: "long", month: "short", day: "numeric" }).format(new Date((nxt as any).scheduled_at)); await tell(acct, t, `Heads up: after your visit on ${when}, your card${card?.last4 ? " ending " + card.last4 : ""} will be charged ${money(t.price_cents)} for ${t.what}. To turn autopay off: ${link(t.autopay.token)}`, "Autopay reminder"); await saveAutopay(t, { heads_up_at: nowIso() }); out.heads_up++; }
      }
      const { data: jobs } = await supabase.from("jobs").select("*").eq("recurring_id", t.id).eq("status", "done").is("invoice_id", null).gte("done_at", since).lte("done_at", settle).order("done_at").limit(10);
      for (const job of jobs || []) {
        if (t.autopay.consent_at && job.done_at < t.autopay.consent_at) continue;       // finished before they agreed: not ours to charge
        const lines = Array.isArray(job.lines) && job.lines.length ? job.lines : r.lines;
        if (linesTotal(lines) <= 0) { out.skipped++; if (!t.autopay.no_price_told) { await saveAutopay(t, { no_price_told: nowIso() }); await tellOwner(acct, `Autopay is on for ${t.name || "a customer"} (${t.what}) but the job has no price, so nothing was charged. Add the price on the job.`); } continue; }
        const contactId = await ensureContact(t);
        const inv: any = await pay({ action: "invoice_create", job_id: job.id, contact_id: contactId, customer_name: job.customer_name || t.name, customer_phone: job.customer_phone || t.phone, customer_email: job.customer_email || t.email, service_address: job.address, lines, notes: "Autopay is on for this service." }, own.id);
        if (!inv?.ok || !inv.invoice?.id) { out.errors.push(`${t.what}: ${inv?.error || "invoice failed"}`); continue; }
        await supabase.from("jobs").update({ invoice_id: inv.invoice.id, lines: inv.invoice.lines, updated_at: nowIso() }).eq("id", job.id).is("invoice_id", null);
        await chargeInvoice(acct, own, t, inv.invoice.id, t.what);
      }
    } catch (e) { out.errors.push(`${t.what}: ${String((e as any)?.message || e)}`); }
  }

  // Junior: finished repeating jobs for customers with autopay on. The parent's account is the merchant.
  let jq = supabase.from("junior_customers").select("*").eq("autopay->>status", "on"); if (only) jq = jq.eq("account_id", only);
  const { data: custs } = await jq.limit(1000);
  for (const c of custs || []) {
    const t = fromJunior(c); const { acct, pa, own } = await ctx(t.account_id); if (!acct || !own || !live(acct, pa)) { out.skipped++; continue; }
    try {
      const { data: jobs } = await supabase.from("junior_jobs").select("*").eq("customer_id", t.id).eq("status", "done").is("invoice_id", null).gt("price_cents", 0).gte("updated_at", since).lte("updated_at", settle).order("updated_at").limit(10);
      for (const job of jobs || []) {
        if (!job.series_id && String(job.repeat || "none") === "none") continue;       // one-off jobs are never charged automatically
        if (t.autopay.consent_at && job.updated_at < t.autopay.consent_at) continue;
        const contactId = await ensureContact(t);
        const inv: any = await pay({ action: "invoice_create", contact_id: contactId, customer_name: t.name, customer_phone: t.phone, customer_email: t.email, lines: [{ desc: job.title, qty: 1, unit_cents: job.price_cents }], notes: "Autopay is on for this service." }, own.id);
        if (!inv?.ok || !inv.invoice?.id) { out.errors.push(`junior ${job.title}: ${inv?.error || "invoice failed"}`); continue; }
        await supabase.from("junior_jobs").update({ invoice_id: inv.invoice.id, updated_at: nowIso() }).eq("id", job.id).is("invoice_id", null);
        const okCharge = await chargeInvoice(acct, own, t, inv.invoice.id, job.title);
        if (okCharge) { try { await fetch(`${SELF}/junior`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "job_paid", id: job.id, method: "online", user_id: own.id }) }); } catch (e) { console.error("junior job_paid", String(e)); } }
      }
    } catch (e) { out.errors.push(`junior ${t.name}: ${String((e as any)?.message || e)}`); }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "");

  // ================================================================ public: the customer's page
  if (["view", "card", "agree", "stop"].includes(action)) {
    const token = String(body.token || "").trim(); if (!/^[a-f0-9]{24}$/.test(token)) return json({ ok: false, error: "not_found" }, 404);
    const t = await loadTarget({ token }); if (!t || !t.autopay) return json({ ok: false, error: "not_found" }, 404);
    const acct = await loadAccount(t.account_id); const pa = await loadPA(t.account_id);
    const online = acct?.settings?.payments?.enabled === true && pa?.charges_enabled === true && !!pa?.stripe_account_id;
    if (action === "stop") {
      if (t.autopay.status !== "off") { await saveAutopay(t, { status: "off", off_at: nowIso(), off_by: "customer" }); await tell(acct, t, `Autopay is off for ${t.what}. Nothing more will be charged automatically. You will get a pay link after each visit instead.`, "Autopay turned off"); await tellOwner(acct, `${t.name || "A customer"} turned autopay off for ${t.what}.`); }
      return json({ ok: true, status: "off" });
    }
    if (t.autopay.status === "needs_parent") return json({ ok: false, error: "not_ready", message: "This is not ready yet. Please check back soon." });
    await ensureContact(t);
    let card = await cardOf(t); if (!card && t.autopay.setup_session && online) card = await pullCard(t, pa);
    if (action === "card") {
      if (!online) return json({ ok: false, error: "online_payments_off", message: `${acct.name} is not set up to take cards online yet. Please contact them.` });
      try {
        const f: Record<string, string> = { mode: "setup", "payment_method_types[0]": "card", success_url: `${link(token)}?card=1`, cancel_url: link(token), "metadata[contact_id]": String(t.contact_id || ""), "metadata[account_id]": t.account_id, "metadata[autopay_token]": token };
        const cust = await stripeCustomer(t, pa); if (cust) f.customer = cust; else if (t.email) f.customer_email = t.email;
        const cs: any = await stripeV1("POST", "/v1/checkout/sessions", f, pa.stripe_account_id);
        await saveAutopay(t, { setup_session: cs.id });
        return json({ ok: true, url: cs.url });
      } catch (e) { console.error("autopay card", e); return json({ ok: false, error: "stripe_error", message: "We could not open the card page just now. Please try again in a minute." }, 502); }
    }
    if (action === "agree") {
      if (t.autopay.status === "on") return json({ ok: true, status: "on" });
      if (t.autopay.status === "off" && t.autopay.off_by !== "customer") return json({ ok: false, error: "closed", message: `${acct.name} is not offering autopay for this right now.` });
      if (!online) return json({ ok: false, error: "online_payments_off", message: `${acct.name} is not set up to take cards online yet.` });
      if (!card) return json({ ok: false, error: "no_card", message: "Add a card first." });
      if (t.kind === "recurring" && t.price_cents <= 0) return json({ ok: false, error: "no_price", message: `${acct.name} has not set the price yet. Please check back soon.` });
      card = (await ensureCustomer(t, pa)) || card;
      await saveAutopay(t, { status: "on", consent_at: nowIso(), off_at: null, off_by: null, last_error: null });
      const jj = t.kind === "junior" ? await juniorJobs(t) : [];
      await tell(acct, t, `Autopay is on for ${t.what}: ${priceWords(t, jj)}, charged to your card${card.last4 ? " ending " + card.last4 : ""} after each visit is done. You get a receipt every time. To turn it off any time: ${link(token)}`, "Autopay is on");
      await tellOwner(acct, `${t.name || "A customer"} turned on autopay for ${t.what}.`);
      return json({ ok: true, status: "on" });
    }
    const jj = t.kind === "junior" ? await juniorJobs(t) : [];
    return json({ ok: true, business: acct?.name || "", what: t.what, price: priceWords(t, jj), has_price: t.kind === "junior" || t.price_cents > 0, status: t.autopay.status, first_name: (t.name || "").split(/\s+/)[0] || "", card: card ? { brand: card.brand || "card", last4: card.last4 || "" } : null, online, junior: t.kind === "junior" });
  }

  // ================================================================ signed in, or internal
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  if (action === "sweep") { if (!caller.internal) return json({ ok: false, error: "internal_only" }, 403); return json(await sweep(body.account_id ? String(body.account_id) : undefined)); }

  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const t = await loadTarget({ recurring_id: body.recurring_id ? String(body.recurring_id) : undefined, junior_customer_id: body.junior_customer_id ? String(body.junior_customer_id) : undefined }, acct.id);
  if (!t) return json({ ok: false, error: "not_found" }, 404);
  const isOwner = String(caller.role).toLowerCase() === "owner";
  const view = () => ({ status: t.autopay?.status || "none", link: t.autopay?.token && t.autopay.status !== "needs_parent" ? link(t.autopay.token) : null, consent_at: t.autopay?.consent_at || null, last_error: t.autopay?.last_error || null });

  if (action === "status") return json({ ok: true, autopay: view() });

  if (action === "request" || action === "approve") {
    if (t.kind === "recurring" && !isAdmin(caller.role)) return json({ ok: false, error: "admins_only", message: "Only an owner or manager can set up autopay." }, 403);
    if (action === "approve" && !isOwner) return json({ ok: false, error: "parent_only", message: "Only a parent can approve this." }, 403);
    if (t.autopay?.status === "on") return json({ ok: true, autopay: view(), message: "Autopay is already on." });
    if (!t.phone && !t.email) return json({ ok: false, error: "no_contact", message: "Add the customer's phone or email first." });
    if (t.kind === "recurring" && t.price_cents <= 0) return json({ ok: false, error: "no_price", message: "Add the price to this repeating job first. Donna never sets a price for you." });
    const pa = await loadPA(acct.id);
    if (acct.settings?.payments?.enabled !== true || !pa?.charges_enabled) return json({ ok: false, error: "online_payments_off", message: t.kind === "junior" ? "A parent needs to connect Stripe in Parent corner first." : "Connect Stripe and turn on online payments first (Settings, Payments)." });
    // Junior: a kid can ask, but only the parent can send it to the customer.
    if (t.kind === "junior" && !isOwner) {
      await saveAutopay(t, { status: "needs_parent", token: t.autopay?.token || newToken(), requested_at: nowIso(), requested_by: caller.userId || null });
      await tellOwner(acct, `Your child asked to set up automatic payment for ${t.name}. Open Customers in Donna to approve it.`);
      return json({ ok: true, autopay: view(), message: "Sent to your parent to approve." });
    }
    await saveAutopay(t, { status: "pending", token: t.autopay?.token || newToken(), requested_at: t.autopay?.requested_at || nowIso(), requested_by: t.autopay?.requested_by || caller.userId || null, approved_by: caller.userId || null, off_at: null, off_by: null });
    await ensureContact(t);
    const sent = await sendAsk(acct, t);
    return json({ ok: true, sent, autopay: view(), message: sent ? `Sent to ${t.name || "the customer"}. Autopay starts once they agree and add a card.` : "Saved, but the link did not send (check the phone or email, and that texting is on). You can copy the link and send it yourself." });
  }

  if (action === "off") {
    if (t.kind === "recurring" && !isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);
    if (!t.autopay) return json({ ok: true, autopay: view() });
    const was = t.autopay.status;
    await saveAutopay(t, { status: "off", off_at: nowIso(), off_by: caller.userId || "business" });
    if (was === "on") await tell(acct, t, `Autopay is now off for ${t.what}. Nothing more will be charged automatically.`, "Autopay turned off");
    return json({ ok: true, autopay: view() });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
