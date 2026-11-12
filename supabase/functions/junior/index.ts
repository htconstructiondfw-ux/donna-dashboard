import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna for Junior Entrepreneurs (v1). Ages 8 to 17, one kid per account.
//
// Decisions (Hubert, Nov 11 2026): the parent is the account owner (adult: pays, gives consent, owns Stripe). The kid has
// their own login. A parent must approve new customers and social posts while the kid is 13 or younger; from 14 the kid
// runs it and the parent still sees everything (a parent can keep approvals on). Donna writes posts and reminds the kid
// when it is time to post; she does not publish to any platform herself. Texts go out one-way from the shared toll-free.
//
//   overview                         -> who is asking (parent/kid), profile, plan, goal, money, to-dos, badges, approvals
//   setup_save {kid_first_name, birth_month, consent, idea}   (parent)  -> profile + parental consent record
//   controls_save {approvals, see_money, notify}              (parent)
//   plan_save {plan} | goal_save {goal}
//   customers | customer_save {customer} | customer_remove {id}
//   jobs {from?,to?} | job_save {job} | job_done {id} | job_paid {id, method} | job_cancel {id, series?} | job_paylink {id}
//   money {month?} | ledger_add {entry} | ledger_remove {id}
//   items | item_save {item} | item_adjust {id, delta} | item_remove {id}
//   posts | post_ideas {about, platform} | post_save {post} | post_posted {id} | post_remove {id}
//   approvals                         (parent) -> everything waiting
//   decide {kind: customer|post, id, approve, note?}          (parent)
//   sweep                             (internal) -> time-to-post reminders, low-stock alerts, repeating jobs

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const MODEL = "claude-haiku-4-5";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (/^\d{10}$/.test(d)) d = "+1" + d; if (/^1\d{10}$/.test(d)) d = "+" + d; return /^\+1\d{10}$/.test(d) ? d : ""; };
const nowIso = () => new Date().toISOString();
const str = (v: any, n: number) => String(v ?? "").trim().slice(0, n);
const cents = (v: any) => Math.max(0, Math.round(Number(v) || 0));
const pad = (n: number) => String(n).padStart(2, "0");
const isDate = (s: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const tzOf = (acct: any) => acct?.settings?.timezone || "America/Chicago";
const todayStr = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonth = (ymd: string) => { const d = new Date(ymd + "T12:00:00Z"); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, dim)); return d.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- who is asking
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
  const { data: me } = await supabase.from("users").select("account_id, role, is_active").eq("id", user.id).maybeSingle();
  if (!(me as any)?.account_id || (me as any).is_active === false) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role, internal: false };
}
async function loadAccount(id: string) { const { data } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", id).maybeSingle(); return data as any; }
const isJunior = (a: any) => String(a?.industry || "") === "junior" || a?.settings?.features?.junior === true;
async function saveJunior(acct: any, patch: Record<string, unknown>) { const settings = { ...(acct.settings || {}), junior: { ...(acct.settings?.junior || {}), ...patch } }; await supabase.from("accounts").update({ settings }).eq("id", acct.id); acct.settings = settings; }

// Age from the birth month (YYYY-MM); the birthday counts from the first of that month.
function ageFrom(birthMonth: string, today: string): number | null {
  const m = String(birthMonth || "").match(/^(\d{4})-(\d{2})$/); if (!m) return null;
  let age = Number(today.slice(0, 4)) - Number(m[1]); if (Number(today.slice(5, 7)) < Number(m[2])) age--; return age;
}
// Parent approval is required at 13 and under, and whenever the parent has kept it on for an older kid.
function approvalRule(acct: any, today: string): { age: number | null; required: boolean; locked: boolean } {
  const j = acct?.settings?.junior || {}; const age = ageFrom(j.birth_month, today);
  const young = age === null || age <= 13;
  return { age, required: young || j.approvals === "on", locked: young };
}

// ---------------------------------------------------------------- telling people things (one-way texts from the shared toll-free, plus email)
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  const num = normPhone(to); if (!num) return false;
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to: num, body }) }); const j: any = await r.json().catch(() => ({})); if (!j?.ok) return false;
    try { const { data: cv } = await supabase.from("conversations").upsert({ account_id: accountId, channel: "sms", customer_identifier: num, last_outbound_at: nowIso(), updated_at: nowIso() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle(); if ((cv as any)?.id) await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: (cv as any).id, direction: "outbound", actor: "donna", channel: "sms", body, status: "sent" }); } catch { /* */ }
    return true; } catch { return false; }
}
async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: "Donna <donna@sidekicklogistics.com>", to: [to], subject, text }) }); return r.ok; } catch { return false; }
}
async function people(acct: any): Promise<{ parent: any; kid: any }> {
  const { data } = await supabase.from("users").select("id, full_name, email, phone, role, is_active").eq("account_id", acct.id).order("created_at");
  const rows = (data || []).filter((u: any) => u.is_active !== false); const kidId = acct?.settings?.junior?.kid_user_id;
  return { parent: rows.find((u: any) => u.role === "owner") || null, kid: rows.find((u: any) => u.id === kidId) || rows.find((u: any) => u.role !== "owner") || null };
}
async function tellParent(acct: any, text: string, subject: string) { const { parent } = await people(acct); if (!parent) return; const note = acct?.settings?.junior?.notify || "both"; if (note !== "email" && parent.phone) await sendText(acct.id, parent.phone, text); if (note !== "text" && parent.email) await sendEmail(parent.email, subject, `${text}\n\nOpen Donna: ${APP}`); }
async function tellKid(acct: any, text: string, subject: string) { const { kid, parent } = await people(acct); const who = kid || parent; if (!who) return; let sent = false; if (who.phone) sent = await sendText(acct.id, who.phone, text); if (who.email) sent = (await sendEmail(who.email, subject, `${text}\n\nOpen Donna: ${APP}`)) || sent; if (!sent && kid && parent?.phone) await sendText(acct.id, parent.phone, text); }

// ---------------------------------------------------------------- Donna writes the posts
const SAFE_POST = `You write short social media posts for a kid (age 8 to 17) who runs a tiny neighborhood business. Rules that are never broken: never state or hint at the kid's age, school, last name, home address, street or exact location; say "my neighborhood" at most. Never ask people to message the kid privately; tell them to call or text the business number or book online. Friendly, upbeat, honest. No claims that are not in the facts given. No emojis unless asked. No hashtags with places or schools. Each post under 280 characters.`;
function fallbackPosts(biz: string, about: string, contact: string): { caption: string; picture_idea: string }[] {
  const a = about || "what I do";
  return [
    { caption: `${biz} is open for business. ${a}. ${contact}`, picture_idea: "A clear photo of your work or your setup, no faces or house numbers in the shot." },
    { caption: `Need a hand this week? ${biz} can help: ${a}. Spots are limited. ${contact}`, picture_idea: "A before and after picture of a job you did." },
    { caption: `Thank you to my customers this week. ${biz} has openings for next week. ${contact}`, picture_idea: "A photo of your supplies or tools laid out neatly." },
  ];
}
async function writePosts(acct: any, about: string, platform: string): Promise<{ caption: string; picture_idea: string }[]> {
  const j = acct.settings?.junior || {}; const biz = acct.name || `${j.kid_first_name || "My"} business`;
  const { data: asst } = await supabase.from("assistants").select("phone_number").eq("account_id", acct.id).not("phone_number", "is", null).limit(1).maybeSingle();
  const phone = String((asst as any)?.phone_number || ""); const contact = phone ? `Call or text ${phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")}.` : "Ask a parent to get in touch.";
  if (!ANTHROPIC_KEY) return fallbackPosts(biz, about, contact);
  try {
    const plan = j.plan || {};
    const user = `Business name: ${biz}\nWhat it does: ${str(plan.what || j.idea || "", 300)}\nPrices: ${str(plan.prices || "", 200)}\nWhen it is open: ${str(plan.when || "", 200)}\nHow to reach the business: ${contact}\nPlatform: ${platform}\nWhat this post should be about: ${str(about, 400) || "a general post that says the business is open"}\n\nWrite 3 different posts. Answer with JSON only: [{"caption":"...","picture_idea":"..."}]. picture_idea is one sentence telling the kid what photo to take, and must remind them: no faces of other people, no house numbers, no license plates.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, max_tokens: 900, system: SAFE_POST, messages: [{ role: "user", content: user }] }) });
    const jr: any = await r.json(); const text = String(jr?.content?.[0]?.text || ""); const m = text.match(/\[[\s\S]*\]/); const arr = m ? JSON.parse(m[0]) : [];
    const out = (Array.isArray(arr) ? arr : []).map((x: any) => ({ caption: str(x?.caption, 500), picture_idea: str(x?.picture_idea, 300) })).filter((x: any) => x.caption).slice(0, 3);
    return out.length ? out : fallbackPosts(biz, about, contact);
  } catch (e) { console.error("writePosts", String(e)); return fallbackPosts(biz, about, contact); }
}

// ---------------------------------------------------------------- money and badges
async function moneyFor(accountId: string, from: string, to: string) {
  const { data } = await supabase.from("junior_ledger").select("*").eq("account_id", accountId).gte("happened_on", from).lte("happened_on", to).order("happened_on", { ascending: false }).order("created_at", { ascending: false }).limit(500);
  const rows = data || []; const sum = (k: string) => rows.filter((r: any) => r.kind === k).reduce((t: number, r: any) => t + r.amount_cents, 0);
  return { rows, income_cents: sum("income"), expense_cents: sum("expense"), saved_cents: sum("saved"), profit_cents: sum("income") - sum("expense") };
}
async function totals(accountId: string) {
  const { data } = await supabase.from("junior_ledger").select("kind, amount_cents").eq("account_id", accountId).limit(5000);
  const sum = (k: string) => (data || []).filter((r: any) => r.kind === k).reduce((t: number, r: any) => t + r.amount_cents, 0);
  return { income_cents: sum("income"), expense_cents: sum("expense"), saved_cents: sum("saved") };
}
function badges(j: any, t: any, counts: any) {
  const goal = j.goal || {};
  return [
    { id: "plan", name: "Planner", how: "Finish your business plan", earned: !!j.plan?.done },
    { id: "first_customer", name: "First customer", how: "Add your first customer", earned: counts.customers >= 1 },
    { id: "first_dollar", name: "First dollar", how: "Get paid for a job", earned: t.income_cents > 0 },
    { id: "five_jobs", name: "Five jobs done", how: "Finish five jobs", earned: counts.jobs_done >= 5 },
    { id: "bookkeeper", name: "Bookkeeper", how: "Write down something you spent", earned: t.expense_cents > 0 },
    { id: "saver", name: "Saver", how: "Put money toward your goal", earned: t.saved_cents > 0 },
    { id: "marketer", name: "Marketer", how: "Share your first post", earned: counts.posted >= 1 },
    { id: "hundred", name: "$100 earned", how: "Earn $100 in total", earned: t.income_cents >= 10000 },
    { id: "goal", name: "Goal reached", how: "Save all the money for your goal", earned: Number(goal.cents) > 0 && t.saved_cents >= Number(goal.cents) },
  ];
}
const TIPS = [
  "Say thank you after every job. Happy customers tell their neighbors.",
  "Write down every dollar you spend on supplies, even small ones. That is how you find out your real profit.",
  "Show up five minutes early. Being on time is the easiest way to stand out.",
  "Before you set a price, add up what your supplies cost. Your price has to be more than that.",
  "Ask a customer: is there anything I could do better? Then do it next time.",
  "Put part of every payment toward your goal before you spend any of it.",
  "A before and after picture is the best ad you can make.",
  "If you are running low on supplies, buy more before you run out, not after.",
  "Never go inside a customer's house alone, and always tell a parent where you are working.",
  "Repeat customers are worth more than new ones. Offer to come back the same day next week.",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "overview");
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

  // ================================================================ sweep (internal)
  if (action === "sweep") {
    if (!caller.internal) return json({ ok: false, error: "internal_only" }, 403);
    const out: any = { ok: true, post_reminders: 0, low_stock: 0, jobs_rolled: 0 };
    // 1. Time to post: approved posts whose time has come. Donna sends the caption to copy; she never posts herself.
    const { data: due } = await supabase.from("junior_posts").select("*").eq("status", "approved").not("scheduled_at", "is", null).lte("scheduled_at", nowIso()).limit(100);
    const accts: Record<string, any> = {}; const acctOf = async (id: string) => accts[id] || (accts[id] = await loadAccount(id));
    for (const p of due || []) {
      const { data: won } = await supabase.from("junior_posts").update({ status: "reminded", reminded_at: nowIso(), updated_at: nowIso() }).eq("id", p.id).eq("status", "approved").select("id").maybeSingle(); if (!won) continue;
      const a = await acctOf(p.account_id); if (!a) continue;
      await tellKid(a, `Donna: time to post${p.platform && p.platform !== "any" ? " on " + p.platform : ""}. Copy this: "${p.caption}"${p.picture_idea ? ` Picture idea: ${p.picture_idea}` : ""} Then mark it posted in Donna.`, "Time to post");
      out.post_reminders++;
    }
    // 2. Low stock: once per item until it is restocked.
    const { data: low } = await supabase.from("junior_items").select("*").is("last_alert_at", null).gt("low_at", 0).limit(500);
    for (const it of low || []) {
      if (Number(it.qty) > Number(it.low_at)) continue;
      const { data: won } = await supabase.from("junior_items").update({ last_alert_at: nowIso() }).eq("id", it.id).is("last_alert_at", null).select("id").maybeSingle(); if (!won) continue;
      const a = await acctOf(it.account_id); if (!a) continue;
      await tellKid(a, `Donna: you are running low on ${it.name} (${Number(it.qty)}${it.unit ? " " + it.unit : ""} left). Time to buy more before your next job.`, `Running low on ${it.name}`);
      out.low_stock++;
    }
    // 3. Repeating jobs: when one is finished or its day has passed, put the next one on the calendar.
    const { data: rep } = await supabase.from("junior_jobs").select("*").neq("repeat", "none").in("status", ["done", "paid"]).not("series_id", "is", null).order("job_date", { ascending: false }).limit(500);
    const seen = new Set<string>();
    for (const jb of rep || []) {
      if (seen.has(jb.series_id)) continue; seen.add(jb.series_id);
      const next = jb.repeat === "weekly" ? addDays(jb.job_date, 7) : jb.repeat === "biweekly" ? addDays(jb.job_date, 14) : addMonth(jb.job_date);
      const { data: have } = await supabase.from("junior_jobs").select("id").eq("series_id", jb.series_id).gte("job_date", next).limit(1); if ((have || []).length) continue;
      await supabase.from("junior_jobs").insert({ account_id: jb.account_id, customer_id: jb.customer_id, title: jb.title, job_date: next, job_time: jb.job_time, repeat: jb.repeat, price_cents: jb.price_cents, series_id: jb.series_id, notes: jb.notes, created_by: jb.created_by });
      out.jobs_rolled++;
    }
    return json(out);
  }

  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  if (!isJunior(acct)) return json({ ok: false, error: "not_junior", message: "This is only for Donna for Junior Entrepreneurs accounts." }, 403);
  const j = acct.settings?.junior || {}; const today = todayStr(tzOf(acct));
  const parent = caller.role === "owner" || (caller.role === "admin" && caller.userId !== j.kid_user_id);
  const rule = approvalRule(acct, today);
  const parentOnly = () => json({ ok: false, error: "parent_only", message: "A parent needs to do that one." }, 403);
  const needSetup = () => json({ ok: false, error: "setup_needed", message: "A parent needs to finish setting up first." }, 403);
  const A = caller.accountId;

  if (action === "overview") {
    const [{ count: customers }, { count: jobsDone }, { count: posted }, t, m, { data: upcoming }, { data: lowItems }, { data: pendC }, { data: pendP }, ppl] = await Promise.all([
      supabase.from("junior_customers").select("id", { count: "exact", head: true }).eq("account_id", A).eq("status", "approved"),
      supabase.from("junior_jobs").select("id", { count: "exact", head: true }).eq("account_id", A).in("status", ["done", "paid"]),
      supabase.from("junior_posts").select("id", { count: "exact", head: true }).eq("account_id", A).eq("status", "posted"),
      totals(A), moneyFor(A, `${today.slice(0, 7)}-01`, today),
      supabase.from("junior_jobs").select("*, junior_customers(name)").eq("account_id", A).eq("status", "scheduled").gte("job_date", addDays(today, -7)).order("job_date").limit(8),
      supabase.from("junior_items").select("id, name, qty, low_at, unit").eq("account_id", A).gt("low_at", 0),
      supabase.from("junior_customers").select("id, name, street, phone, created_at").eq("account_id", A).eq("status", "pending").order("created_at"),
      supabase.from("junior_posts").select("id, caption, platform, picture_idea, scheduled_at, created_at").eq("account_id", A).eq("status", "needs_parent").order("created_at"),
      people(acct),
    ]);
    const counts = { customers: customers || 0, jobs_done: jobsDone || 0, posted: posted || 0 };
    const { data: toPost } = await supabase.from("junior_posts").select("id, caption, platform, picture_idea, scheduled_at, status").eq("account_id", A).in("status", ["approved", "reminded"]).order("scheduled_at").limit(5);
    const dayN = Math.floor(new Date(today + "T12:00:00Z").getTime() / 86400000);
    return json({ ok: true, role: parent ? "parent" : "kid", setup_done: !!j.consent_at && !!j.kid_first_name, age: parent ? rule.age : undefined, approvals_required: rule.required, approvals_locked: rule.locked,
      profile: { kid_first_name: j.kid_first_name || "", idea: j.idea || "", business: acct.name, birth_month: parent ? j.birth_month || "" : undefined, consent_at: parent ? j.consent_at || null : undefined, kid_login: !!ppl.kid, kid_email: parent ? ppl.kid?.email || null : undefined },
      controls: { approvals: rule.required ? "on" : "off", notify: j.notify || "both" },
      plan: j.plan || null, goal: j.goal || null, totals: t, month: { income_cents: m.income_cents, expense_cents: m.expense_cents, profit_cents: m.profit_cents, saved_cents: m.saved_cents },
      upcoming: (upcoming || []).map((x: any) => ({ id: x.id, title: x.title, job_date: x.job_date, job_time: x.job_time, price_cents: x.price_cents, customer: x.junior_customers?.name || "", late: x.job_date < today })),
      low_stock: (lowItems || []).filter((i: any) => Number(i.qty) <= Number(i.low_at)), to_post: toPost || [],
      pending: { customers: parent ? pendC || [] : (pendC || []).map((c: any) => ({ id: c.id, name: c.name })), posts: pendP || [] },
      badges: badges(j, t, counts), counts, tip: TIPS[dayN % TIPS.length] });
  }

  if (action === "setup_save") {
    if (!parent) return parentOnly();
    const name = str(body.kid_first_name, 30).split(/\s+/)[0] || ""; const bm = String(body.birth_month || "");
    if (!name) return json({ ok: false, error: "invalid", message: "Add your child's first name." });
    const age = ageFrom(bm, today); if (age === null) return json({ ok: false, error: "invalid", message: "Pick your child's birth month and year." });
    if (age < 8 || age > 17) return json({ ok: false, error: "age", message: "Donna for Junior Entrepreneurs is for ages 8 to 17." });
    if (body.consent !== true && !j.consent_at) return json({ ok: false, error: "consent", message: "Please tick the box to give your permission as the parent or guardian." });
    const patch: any = { kid_first_name: name, birth_month: bm, idea: str(body.idea, 40) || j.idea || "" };
    if (!j.consent_at) { patch.consent_at = nowIso(); patch.consent_by = caller.userId; patch.consent_text = "I am this child's parent or legal guardian. I give permission for my child to use Donna, and for Donna to collect and use the information my child enters to run their business. I can see everything and can delete it at any time."; }
    if (body.kid_user_id !== undefined) { const { data: u } = await supabase.from("users").select("id").eq("id", String(body.kid_user_id)).eq("account_id", A).maybeSingle(); if (u) patch.kid_user_id = (u as any).id; }
    await saveJunior(acct, patch);
    return json({ ok: true, age, approvals_required: approvalRule(acct, today).required });
  }

  if (action === "controls_save") {
    if (!parent) return parentOnly(); const patch: any = {};
    if (body.approvals !== undefined) { if (rule.locked && body.approvals !== "on") return json({ ok: false, error: "locked", message: "Approvals stay on until your child turns 14." }); patch.approvals = body.approvals === "on" ? "on" : "off"; }
    if (["text", "email", "both"].includes(body.notify)) patch.notify = body.notify;
    if (body.kid_user_id !== undefined) { const { data: u } = await supabase.from("users").select("id").eq("id", String(body.kid_user_id)).eq("account_id", A).maybeSingle(); if (u) patch.kid_user_id = (u as any).id; }
    await saveJunior(acct, patch); return json({ ok: true, approvals_required: approvalRule(acct, today).required });
  }

  if (!j.consent_at) return needSetup();

  if (action === "plan_save") {
    const p = body.plan || {}; const plan: any = { idea: str(p.idea, 40), what: str(p.what, 400), who: str(p.who, 300), prices: str(p.prices, 300), supplies: str(p.supplies, 400), when: str(p.when, 300), safety: p.safety === true, cost_per_cents: cents(p.cost_per_cents), price_per_cents: cents(p.price_per_cents), done: p.done === true, updated_at: nowIso() };
    const patch: any = { plan, idea: plan.idea || j.idea || "" };
    await saveJunior(acct, patch);
    const bn = str(p.business_name, 60); if (bn && bn !== acct.name && parent) await supabase.from("accounts").update({ name: bn }).eq("id", A);
    return json({ ok: true, plan });
  }

  if (action === "goal_save") {
    const g = body.goal || {}; const goal = { name: str(g.name, 60), cents: cents(g.cents), save_pct: Math.min(100, Math.max(0, Math.round(Number(g.save_pct) || 0))) };
    if (!goal.name || goal.cents <= 0) return json({ ok: false, error: "invalid", message: "Say what you are saving for and how much it costs." });
    await saveJunior(acct, { goal }); return json({ ok: true, goal });
  }

  // ---------------------------------------------------------------- customers
  if (action === "customers") {
    const { data } = await supabase.from("junior_customers").select("*").eq("account_id", A).neq("status", "declined").order("name");
    return json({ ok: true, customers: data || [], approvals_required: rule.required });
  }
  if (action === "customer_save") {
    const c = body.customer || {}; const name = str(c.name, 80); if (!name) return json({ ok: false, error: "invalid", message: "Add the customer's name." });
    const phone = c.phone ? normPhone(String(c.phone)) : ""; if (c.phone && !phone) return json({ ok: false, error: "invalid", message: "That phone number does not look right." });
    const row: any = { name, phone: phone || null, email: str(c.email, 120).toLowerCase() || null, street: str(c.street, 160) || null, notes: str(c.notes, 400) || null, updated_at: nowIso() };
    if (c.id) {
      const { data: cur } = await supabase.from("junior_customers").select("*").eq("id", String(c.id)).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
      // A kid who needs approval changing where they work sends it back to the parent.
      if (!parent && rule.required && (row.street || "") !== ((cur as any).street || "") && (cur as any).status === "approved") row.status = "pending";
      const { data } = await supabase.from("junior_customers").update(row).eq("id", (cur as any).id).select("*").maybeSingle();
      if (row.status === "pending") await tellParent(acct, `Donna: ${j.kid_first_name || "Your child"} changed the address for customer ${name}. Please approve it.`, "A customer change needs your OK");
      return json({ ok: true, customer: data, pending: row.status === "pending" });
    }
    const pending = !parent && rule.required;
    const { data, error } = await supabase.from("junior_customers").insert({ ...row, account_id: A, status: pending ? "pending" : "approved", created_by: caller.userId || null }).select("*").maybeSingle();
    if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400);
    if (pending) await tellParent(acct, `Donna: ${j.kid_first_name || "Your child"} wants to add a new customer: ${name}${row.street ? " at " + row.street : ""}. Please approve or decline.`, "A new customer needs your OK");
    return json({ ok: true, customer: data, pending });
  }
  if (action === "customer_remove") {
    const { data: cur } = await supabase.from("junior_customers").select("id, status").eq("id", String(body.id || "")).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
    await supabase.from("junior_customers").update({ status: "declined", updated_at: nowIso() }).eq("id", (cur as any).id); return json({ ok: true });
  }

  // ---------------------------------------------------------------- jobs
  const loadJob = async (id: string) => { const { data } = await supabase.from("junior_jobs").select("*, junior_customers(name, phone, email, status)").eq("id", id).eq("account_id", A).maybeSingle(); return data as any; };
  if (action === "jobs") {
    const from = isDate(body.from) ? body.from : addDays(today, -30); const to = isDate(body.to) ? body.to : addDays(today, 60);
    const { data } = await supabase.from("junior_jobs").select("*, junior_customers(name)").eq("account_id", A).gte("job_date", from).lte("job_date", to).neq("status", "canceled").order("job_date").order("job_time").limit(400);
    return json({ ok: true, today, jobs: (data || []).map((x: any) => ({ ...x, customer: x.junior_customers?.name || "", junior_customers: undefined })) });
  }
  if (action === "job_save") {
    const b = body.job || {}; const title = str(b.title, 100); if (!title) return json({ ok: false, error: "invalid", message: "Say what the job is." });
    if (!isDate(b.job_date)) return json({ ok: false, error: "invalid", message: "Pick the day." });
    let customerId: string | null = null;
    if (b.customer_id) { const { data: c } = await supabase.from("junior_customers").select("id, status, name").eq("id", String(b.customer_id)).eq("account_id", A).maybeSingle(); if (!c) return json({ ok: false, error: "invalid", message: "Pick a customer from your list." }); if ((c as any).status !== "approved") return json({ ok: false, error: "customer_pending", message: `A parent needs to approve ${(c as any).name} before you can book a job for them.` }); customerId = (c as any).id; }
    const row: any = { customer_id: customerId, title, job_date: b.job_date, job_time: /^\d{2}:\d{2}$/.test(String(b.job_time || "")) ? b.job_time : null, repeat: ["none", "weekly", "biweekly", "monthly"].includes(b.repeat) ? b.repeat : "none", price_cents: cents(b.price_cents), notes: str(b.notes, 400) || null, updated_at: nowIso() };
    if (b.id) { const cur = await loadJob(String(b.id)); if (!cur) return json({ ok: false, error: "not_found" }, 404); const { data } = await supabase.from("junior_jobs").update({ ...row, series_id: row.repeat === "none" ? null : cur.series_id || crypto.randomUUID() }).eq("id", cur.id).select("*").maybeSingle(); return json({ ok: true, job: data }); }
    const { data, error } = await supabase.from("junior_jobs").insert({ ...row, account_id: A, series_id: row.repeat === "none" ? null : crypto.randomUUID(), created_by: caller.userId || null }).select("*").maybeSingle();
    if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400);
    return json({ ok: true, job: data });
  }
  if (action === "job_done" || action === "job_paid" || action === "job_cancel") {
    const jb = await loadJob(String(body.id || "")); if (!jb) return json({ ok: false, error: "not_found" }, 404);
    if (action === "job_cancel") { if (body.series === true && jb.series_id) await supabase.from("junior_jobs").update({ status: "canceled", updated_at: nowIso() }).eq("series_id", jb.series_id).eq("status", "scheduled"); else await supabase.from("junior_jobs").update({ status: "canceled", repeat: body.series === true ? "none" : jb.repeat, updated_at: nowIso() }).eq("id", jb.id); return json({ ok: true }); }
    if (action === "job_done") { if (jb.status === "scheduled") await supabase.from("junior_jobs").update({ status: "done", updated_at: nowIso() }).eq("id", jb.id); return json({ ok: true }); }
    if (jb.status === "paid") return json({ ok: true, already: true });
    const method = ["cash", "check", "venmo", "zelle", "cashapp", "online", "other"].includes(body.method) ? body.method : "cash";
    const amount = body.amount_cents !== undefined ? cents(body.amount_cents) : jb.price_cents;
    await supabase.from("junior_jobs").update({ status: "paid", paid_method: method, paid_at: nowIso(), updated_at: nowIso() }).eq("id", jb.id);
    let saved = 0;
    if (amount > 0) {
      const { error } = await supabase.from("junior_ledger").insert({ account_id: A, kind: "income", amount_cents: amount, category: "job", note: `${jb.title}${jb.junior_customers?.name ? " for " + jb.junior_customers.name : ""} (${method})`, happened_on: today, job_id: jb.id, created_by: caller.userId || null });
      const pct = Number(j.goal?.save_pct) || 0;
      if (!error && pct > 0 && j.goal?.cents > 0) { saved = Math.round(amount * pct / 100); if (saved > 0) await supabase.from("junior_ledger").insert({ account_id: A, kind: "saved", amount_cents: saved, category: "goal", note: `${pct}% of ${money(amount)} toward ${j.goal.name}`, happened_on: today, created_by: caller.userId || null }); }
    }
    return json({ ok: true, amount_cents: amount, saved_cents: saved });
  }
  if (action === "job_paylink") {
    // Online payment goes to the PARENT's Stripe account (an adult is always the merchant). Uses the shared payments module.
    const jb = await loadJob(String(body.id || "")); if (!jb) return json({ ok: false, error: "not_found" }, 404);
    if (jb.price_cents <= 0) return json({ ok: false, error: "invalid", message: "Add a price to the job first." });
    const cust = jb.junior_customers; if (!cust?.phone && !cust?.email) return json({ ok: false, error: "no_contact", message: "Add the customer's phone or email first." });
    const { parent: par } = await people(acct); if (!par) return json({ ok: false, error: "no_parent" }, 400);
    const { data: pa } = await supabase.from("payment_accounts").select("charges_enabled").eq("account_id", A).maybeSingle();
    if (!(pa as any)?.charges_enabled || acct.settings?.payments?.enabled !== true) return json({ ok: false, error: "payments_off", message: "Online payments are not set up yet. A parent can connect Stripe in Parent corner, or mark this job paid in cash." });
    const pay = async (b: any) => { const r = await fetch(`${SELF}/payments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ ...b, user_id: par.id }) }); return await r.json().catch(() => ({})); };
    let invId = jb.invoice_id;
    if (!invId) { const c: any = await pay({ action: "invoice_create", customer_name: cust.name, customer_phone: cust.phone, customer_email: cust.email, lines: [{ desc: jb.title, qty: 1, unit_cents: jb.price_cents }] }); if (!c?.ok || !c.invoice?.id) return json({ ok: false, error: "invoice_failed", message: c?.message || "Could not make the pay link." }); invId = c.invoice.id; await supabase.from("junior_jobs").update({ invoice_id: invId, status: jb.status === "scheduled" ? "done" : jb.status, updated_at: nowIso() }).eq("id", jb.id); }
    const s: any = await pay({ action: "invoice_send", id: invId }); if (!s?.ok) return json({ ok: false, error: "not_sent", message: s?.message || "The pay link did not send.", pay_url: s?.pay_url });
    return json({ ok: true, pay_url: s.pay_url });
  }

  // ---------------------------------------------------------------- money
  if (action === "money") {
    const month = /^\d{4}-\d{2}$/.test(String(body.month || "")) ? String(body.month) : today.slice(0, 7); const [y, mo] = month.split("-").map(Number);
    const m = await moneyFor(A, `${month}-01`, `${month}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`); const t = await totals(A);
    // Jobs paid online through the parent's Stripe land in the ledger the first time money is opened after they clear.
    const { data: paidOnline } = await supabase.from("junior_jobs").select("id, title, price_cents, invoice_id, invoices(paid_at, total_cents)").eq("account_id", A).not("invoice_id", "is", null).neq("status", "paid").limit(50);
    let synced = 0; for (const jb of paidOnline || []) { const inv: any = (jb as any).invoices; if (!inv?.paid_at) continue; await supabase.from("junior_jobs").update({ status: "paid", paid_method: "online", paid_at: inv.paid_at, updated_at: nowIso() }).eq("id", (jb as any).id); const { error } = await supabase.from("junior_ledger").insert({ account_id: A, kind: "income", amount_cents: (jb as any).price_cents, category: "job", note: `${(jb as any).title} (paid online)`, happened_on: String(inv.paid_at).slice(0, 10), job_id: (jb as any).id }); if (!error) synced++; }
    if (synced) { const m2 = await moneyFor(A, `${month}-01`, `${month}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`); return json({ ok: true, month, ...m2, totals: await totals(A), goal: j.goal || null }); }
    return json({ ok: true, month, ...m, totals: t, goal: j.goal || null });
  }
  if (action === "ledger_add") {
    const e = body.entry || {}; const kind = ["income", "expense", "saved"].includes(e.kind) ? e.kind : ""; const amount = cents(e.amount_cents);
    if (!kind || amount <= 0) return json({ ok: false, error: "invalid", message: "Add an amount." });
    if (kind === "saved") { const t = await totals(A); if (amount > t.income_cents - t.expense_cents - t.saved_cents) return json({ ok: false, error: "too_much", message: `You can save up to ${money(Math.max(0, t.income_cents - t.expense_cents - t.saved_cents))} right now. That is the money you have made that is not spent or saved yet.` }); }
    const { data, error } = await supabase.from("junior_ledger").insert({ account_id: A, kind, amount_cents: amount, category: str(e.category, 40) || null, note: str(e.note, 200) || null, happened_on: isDate(e.happened_on) ? e.happened_on : today, created_by: caller.userId || null }).select("*").maybeSingle();
    if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400); return json({ ok: true, entry: data });
  }
  if (action === "ledger_remove") {
    const { data: cur } = await supabase.from("junior_ledger").select("id, job_id").eq("id", String(body.id || "")).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
    if ((cur as any).job_id) return json({ ok: false, error: "from_job", message: "This came from a paid job, so it stays in your records." });
    await supabase.from("junior_ledger").delete().eq("id", (cur as any).id); return json({ ok: true });
  }

  // ---------------------------------------------------------------- supplies
  if (action === "items") { const { data } = await supabase.from("junior_items").select("*").eq("account_id", A).order("name"); return json({ ok: true, items: data || [] }); }
  if (action === "item_save") {
    const i = body.item || {}; const name = str(i.name, 60); if (!name) return json({ ok: false, error: "invalid", message: "Name the supply." });
    const row: any = { name, unit: str(i.unit, 20) || null, qty: Math.max(0, Number(i.qty) || 0), low_at: Math.max(0, Number(i.low_at) || 0), cost_cents: i.cost_cents ? cents(i.cost_cents) : null, updated_at: nowIso() };
    if (row.qty > row.low_at) row.last_alert_at = null;
    if (i.id) { const { data } = await supabase.from("junior_items").update(row).eq("id", String(i.id)).eq("account_id", A).select("*").maybeSingle(); if (!data) return json({ ok: false, error: "not_found" }, 404); return json({ ok: true, item: data }); }
    const { data, error } = await supabase.from("junior_items").insert({ ...row, account_id: A }).select("*").maybeSingle(); if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400); return json({ ok: true, item: data });
  }
  if (action === "item_adjust") {
    const { data: cur } = await supabase.from("junior_items").select("*").eq("id", String(body.id || "")).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
    const qty = Math.max(0, Number((cur as any).qty) + (Number(body.delta) || 0)); const patch: any = { qty, updated_at: nowIso() }; if (qty > Number((cur as any).low_at)) patch.last_alert_at = null;
    const { data } = await supabase.from("junior_items").update(patch).eq("id", (cur as any).id).select("*").maybeSingle(); return json({ ok: true, item: data, low: qty <= Number((cur as any).low_at) && Number((cur as any).low_at) > 0 });
  }
  if (action === "item_remove") { await supabase.from("junior_items").delete().eq("id", String(body.id || "")).eq("account_id", A); return json({ ok: true }); }

  // ---------------------------------------------------------------- posts
  if (action === "posts") { const { data } = await supabase.from("junior_posts").select("*").eq("account_id", A).order("created_at", { ascending: false }).limit(100); return json({ ok: true, posts: data || [], approvals_required: rule.required }); }
  if (action === "post_ideas") { const ideas = await writePosts(acct, str(body.about, 400), str(body.platform, 20) || "any"); return json({ ok: true, ideas }); }
  if (action === "post_save") {
    const p = body.post || {}; const caption = str(p.caption, 600); if (!caption) return json({ ok: false, error: "invalid", message: "Write the post first." });
    const when = p.scheduled_at && !isNaN(Date.parse(p.scheduled_at)) ? new Date(p.scheduled_at).toISOString() : null;
    // A kid's post (new or edited) goes to the parent whenever approval is required. A parent's own save is approved.
    const status = p.draft === true ? "draft" : (!parent && rule.required) ? "needs_parent" : "approved";
    const row: any = { platform: ["instagram", "facebook", "tiktok", "nextdoor", "any"].includes(p.platform) ? p.platform : "any", caption, picture_idea: str(p.picture_idea, 300) || null, scheduled_at: when, status, updated_at: nowIso(), reminded_at: null };
    if (status === "approved") { row.decided_by = parent ? caller.userId : null; row.decided_at = nowIso(); }
    let saved: any = null;
    if (p.id) { const { data: cur } = await supabase.from("junior_posts").select("id, status").eq("id", String(p.id)).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404); if ((cur as any).status === "posted") return json({ ok: false, error: "posted", message: "This one is already posted." }); const { data } = await supabase.from("junior_posts").update(row).eq("id", (cur as any).id).select("*").maybeSingle(); saved = data; }
    else { const { data, error } = await supabase.from("junior_posts").insert({ ...row, account_id: A, created_by: caller.userId || null }).select("*").maybeSingle(); if (error) return json({ ok: false, error: "save_failed", message: error.message }, 400); saved = data; }
    if (status === "needs_parent") await tellParent(acct, `Donna: ${j.kid_first_name || "Your child"} wrote a post and needs your OK before sharing it: "${caption.slice(0, 200)}"`, "A post needs your OK");
    return json({ ok: true, post: saved, needs_parent: status === "needs_parent" });
  }
  if (action === "post_posted") {
    const { data: cur } = await supabase.from("junior_posts").select("id, status").eq("id", String(body.id || "")).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
    if (!["approved", "reminded", "posted"].includes((cur as any).status)) return json({ ok: false, error: "not_approved", message: "A parent needs to approve this post before you share it." });
    await supabase.from("junior_posts").update({ status: "posted", posted_at: nowIso(), updated_at: nowIso() }).eq("id", (cur as any).id); return json({ ok: true });
  }
  if (action === "post_remove") { const { data: cur } = await supabase.from("junior_posts").select("id").eq("id", String(body.id || "")).eq("account_id", A).maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404); await supabase.from("junior_posts").delete().eq("id", (cur as any).id); return json({ ok: true }); }

  // ---------------------------------------------------------------- parent corner
  if (action === "approvals") {
    if (!parent) return parentOnly();
    const [{ data: c }, { data: p }] = await Promise.all([supabase.from("junior_customers").select("*").eq("account_id", A).eq("status", "pending").order("created_at"), supabase.from("junior_posts").select("*").eq("account_id", A).eq("status", "needs_parent").order("created_at")]);
    return json({ ok: true, customers: c || [], posts: p || [] });
  }
  if (action === "decide") {
    if (!parent) return parentOnly(); const approve = body.approve === true; const note = str(body.note, 200) || null; const id = String(body.id || "");
    if (body.kind === "customer") {
      const { data: cur } = await supabase.from("junior_customers").update({ status: approve ? "approved" : "declined", updated_at: nowIso() }).eq("id", id).eq("account_id", A).eq("status", "pending").select("name").maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
      await tellKid(acct, approve ? `Donna: good news. ${(cur as any).name} is approved as a customer. You can book a job for them now.` : `Donna: your parent said no to adding ${(cur as any).name} for now.${note ? " Note: " + note : ""} Talk it over with them.`, approve ? "Customer approved" : "Customer not approved");
      return json({ ok: true });
    }
    if (body.kind === "post") {
      const { data: cur } = await supabase.from("junior_posts").update({ status: approve ? "approved" : "declined", parent_note: note, decided_by: caller.userId, decided_at: nowIso(), updated_at: nowIso() }).eq("id", id).eq("account_id", A).eq("status", "needs_parent").select("caption, scheduled_at").maybeSingle(); if (!cur) return json({ ok: false, error: "not_found" }, 404);
      await tellKid(acct, approve ? `Donna: your post is approved.${(cur as any).scheduled_at ? " I will remind you when it is time to share it." : " You can share it any time."}` : `Donna: your parent wants a change to your post before you share it.${note ? " Note: " + note : ""}`, approve ? "Post approved" : "Post needs a change");
      return json({ ok: true });
    }
    return json({ ok: false, error: "bad_kind" }, 400);
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
