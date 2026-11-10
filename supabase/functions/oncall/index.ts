import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna on-call ladder (v1). Pages the first person on the ladder for an emergency job; if nobody acknowledges
// within the account's window, pages the next one, then the owner. Acknowledging = texting ACK / "got it" / OMW on
// that job, or tapping Acknowledge in the app.
// Ladder: settings.contractor.on_call = [user_id, ...] in order (falls back to after_hours_page_phone, then the owner).
// Window: settings.contractor.escalate_after_min (default 15).
// Actions (service role, cron secret, or a signed-in user for ack/status):
//   page   {account_id, job_id, message, user_id?}  -> start the ladder (step 0)
//   ack    {job_id | page_id}                        -> mark acknowledged (by the caller or body.user_id)
//   sweep                                            -> escalate every unacked page past its window (cron, every 5 min)
//   status {job_id}                                  -> pages for a job

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}

// Ordered list of {user_id, phone, name} to page, de-duplicated, owner last.
async function ladder(acct: any): Promise<{ user_id: string | null; phone: string; name: string }[]> {
  const ctr: any = acct.settings?.contractor || {};
  const { data: users } = await supabase.from("users").select("id, full_name, phone, role").eq("account_id", acct.id).eq("is_active", true);
  const byId = new Map((users || []).map((u: any) => [u.id, u]));
  const out: { user_id: string | null; phone: string; name: string }[] = [];
  const push = (u: any) => { if (u?.phone && !out.some((o) => o.phone === u.phone)) out.push({ user_id: u.id || null, phone: String(u.phone).trim(), name: String(u.full_name || u.name || "").split(/\s+/)[0] || "tech" }); };
  for (const id of (Array.isArray(ctr.on_call) ? ctr.on_call : [])) push(byId.get(id));
  if (!out.length && ctr.after_hours_page_phone) push({ id: null, phone: ctr.after_hours_page_phone, full_name: "On-call" });
  const owner = (users || []).find((u: any) => u.role === "owner"); if (owner) push(owner);
  return out;
}

async function pageStep(acct: any, job: any, message: string, step: number): Promise<any> {
  const lad = await ladder(acct);
  const who = lad[Math.min(step, lad.length - 1)]; if (!who) return null;
  const more = step < lad.length - 1;
  const text = `${acct.name} ${step === 0 ? "AFTER-HOURS" : "STILL UNANSWERED (" + step + ")"}: ${message}${more ? ` Reply ACK to take it; otherwise ${lad[step + 1].name} is paged in ${Number(acct.settings?.contractor?.escalate_after_min) || 15} min.` : " Reply ACK to take it."}`;
  const sent = await sendText(acct.id, who.phone, text);
  const { data } = await supabase.from("pages").insert({ account_id: acct.id, job_id: job?.id || null, step, to_phone: who.phone, to_user_id: who.user_id, message }).select("*").maybeSingle();
  if (job?.id && who.user_id && step > 0) await supabase.from("jobs").update({ assigned_user_id: who.user_id, updated_at: new Date().toISOString() }).eq("id", job.id);
  return { page: data, sent, to: who, last: !more };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "");
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let userId = String(body.user_id || ""), accountId = String(body.account_id || "");
  let trusted = auth === SERVICE_ROLE;
  if (!trusted) {
    const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
    trusted = !!(sec as any)?.value && (req.headers.get("x-cron-secret") || "") === (sec as any).value;
  }
  if (!trusted) {
    const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
    const { data: { user } } = await userClient.auth.getUser(auth);
    if (!user) return json({ ok: false, error: "unauthorized" }, 401);
    const { data: me } = await supabase.from("users").select("id, account_id").eq("id", user.id).maybeSingle();
    if (!(me as any)?.account_id) return json({ ok: false, error: "unauthorized" }, 401);
    userId = (me as any).id; accountId = (me as any).account_id;
    if (!["ack", "status"].includes(action)) return json({ ok: false, error: "forbidden" }, 403);
  }

  if (action === "sweep") {
    // Every unacked page older than its account's window gets the next rung.
    const { data: open } = await supabase.from("pages").select("*").is("acked_at", null).is("escalated_at", null).order("sent_at").limit(200);
    let escalated = 0;
    for (const p of (open || []) as any[]) {
      const { data: acct } = await supabase.from("accounts").select("id, name, settings").eq("id", p.account_id).maybeSingle(); if (!acct) continue;
      const mins = Number(acct.settings?.contractor?.escalate_after_min) || 15;
      if (Date.now() - new Date(p.sent_at).getTime() < mins * 60000) continue;
      // Already acknowledged some other way (OMW / started on the job)?
      if (p.job_id) { const { data: j } = await supabase.from("jobs").select("id, status").eq("id", p.job_id).maybeSingle(); if (j && ["en_route", "in_progress", "done", "invoiced", "paid", "cancelled"].includes(j.status)) { await supabase.from("pages").update({ acked_at: new Date().toISOString() }).eq("id", p.id); continue; } }
      const lad = await ladder(acct);
      await supabase.from("pages").update({ escalated_at: new Date().toISOString() }).eq("id", p.id);
      if (p.step >= lad.length - 1) continue; // owner was last; nothing above him
      const job = p.job_id ? (await supabase.from("jobs").select("*").eq("id", p.job_id).maybeSingle()).data : null;
      await pageStep(acct, job, p.message, p.step + 1); escalated++;
    }
    return json({ ok: true, checked: (open || []).length, escalated });
  }

  if (action === "page") {
    const { data: acct } = await supabase.from("accounts").select("id, name, settings").eq("id", accountId).maybeSingle(); if (!acct) return json({ ok: false, error: "no_account" }, 404);
    const job = body.job_id ? (await supabase.from("jobs").select("*").eq("id", body.job_id).maybeSingle()).data : null;
    const r = await pageStep(acct, job, String(body.message || "").slice(0, 400), 0);
    return json({ ok: !!r, ...(r || {}) });
  }

  if (action === "ack") {
    let q = supabase.from("pages").select("*").is("acked_at", null).eq("account_id", accountId).order("sent_at", { ascending: false }).limit(1);
    if (body.page_id) q = q.eq("id", body.page_id); else if (body.job_id) q = q.eq("job_id", body.job_id);
    const { data: p } = await q.maybeSingle(); if (!p) return json({ ok: false, error: "nothing_to_ack" });
    const now = new Date().toISOString();
    await supabase.from("pages").update({ acked_at: now, acked_by: userId || null }).eq("account_id", accountId).eq("job_id", p.job_id).is("acked_at", null);
    if (p.job_id && userId) await supabase.from("jobs").update({ assigned_user_id: userId, updated_at: now }).eq("id", p.job_id);
    // Tell the earlier rungs it's covered.
    const { data: earlier } = await supabase.from("pages").select("to_phone").eq("job_id", p.job_id).neq("to_phone", p.to_phone);
    const { data: who } = userId ? await supabase.from("users").select("full_name").eq("id", userId).maybeSingle() : { data: null };
    const name = String((who as any)?.full_name || "someone").split(/\s+/)[0];
    for (const e of (earlier || []) as any[]) await sendText(accountId, e.to_phone, `Covered: ${name} took the after-hours call${p.message ? " (" + p.message.slice(0, 80) + "…)" : ""}.`);
    return json({ ok: true, job_id: p.job_id });
  }

  if (action === "status") {
    const { data } = await supabase.from("pages").select("*").eq("account_id", accountId).eq("job_id", String(body.job_id || "")).order("sent_at");
    return json({ ok: true, pages: data || [] });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
