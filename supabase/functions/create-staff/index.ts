import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna: team logins under the caller's own account (any vertical).
//   action "create"  (default) — name, email, role (member|admin), is_bookable, title, and EITHER a temporary
//                     password OR invite:true (Supabase emails a set-your-password link).
//   action "resend_invite" — user_id: sends the invite email again.
//   action "deactivate" / "reactivate" — user_id: flips users.is_active and bans/unbans the auth user, which
//                     also kills the phone app session. Owners cannot be deactivated; you cannot deactivate yourself.
// Every path checks the caller is an owner/admin of the same account; a person can only ever be created under
// the caller's own account (single-use staff_invites token consumed by the signup trigger).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const DASH_URL = (Deno.env.get("DASHBOARD_URL") || "https://donna-dashboard-three.vercel.app").replace(/\/$/, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });
const emailOk = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// Default title by vertical when the caller doesn't give one.
function defaultTitle(acct: any, role: string): string {
  if (role === "admin") return "Manager";
  const ind = String(acct?.industry || acct?.settings?.industry || "").toLowerCase();
  const f = acct?.settings?.features || {};
  const label = acct?.settings?.provider_label;
  if (label) return String(label).charAt(0).toUpperCase() + String(label).slice(1);
  if (ind === "contractor") return "Technician";
  if (ind === "real_estate" || f.real_estate) return "Agent";
  if (f.property_management || ind === "property_management") return "Property manager";
  if (f.salon || ind === "salon") return "Stylist";
  return "Staff";
}
// v6: audit trail (activity_log) for create / deactivate / reactivate.
async function logActivity(accountId: string, actor: string | null, action: string, entity: string, entityId: string | null, label: string | null, details: Record<string, unknown> = {}) {
  try { await admin.rpc("log_activity", { p_account: accountId, p_actor: actor || null, p_action: action, p_entity: entity, p_entity_id: entityId, p_label: label, p_details: details }); } catch (e) { console.error("log_activity", String(e)); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_body" }, 400); }

  // Who is asking: a signed-in owner/admin of the account, or the platform (cron secret + account_id) provisioning a tenant's team.
  let accountId = "", callerId: string | null = null;
  const cronHeader = req.headers.get("x-cron-secret") || "";
  if (cronHeader) {
    const { data: secretRow } = await admin.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
    if (!secretRow?.value || cronHeader !== secretRow.value) return json({ ok: false, error: "forbidden" }, 403);
    accountId = String(body?.account_id || "");
    if (!accountId) return json({ ok: false, error: "account_id required" }, 400);
    const { data: owner } = await admin.from("users").select("id").eq("account_id", accountId).eq("role", "owner").order("created_at").limit(1).maybeSingle();
    callerId = owner?.id || null;
  } else {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ ok: false, error: "Not signed in." }, 401);
    const { data: u, error: ue } = await admin.auth.getUser(token);
    if (ue || !u?.user) return json({ ok: false, error: "Not signed in." }, 401);
    const { data: me } = await admin.from("users").select("account_id, role, is_active").eq("id", u.user.id).maybeSingle();
    if (!me?.account_id || me.is_active === false) return json({ ok: false, error: "No account found." }, 403);
    if (me.role !== "owner" && me.role !== "admin") return json({ ok: false, error: "Only an owner or manager can manage the team." }, 403);
    accountId = me.account_id; callerId = u.user.id;
  }
  const { data: acct } = await admin.from("accounts").select("id, name, industry, settings, plan").eq("id", accountId).maybeSingle();

  const action = String(body?.action || "create");

  // ---- deactivate / reactivate / resend ------------------------------------------------------------
  if (action === "deactivate" || action === "reactivate" || action === "resend_invite") {
    const userId = String(body?.user_id || "");
    const { data: target } = await admin.from("users").select("id, account_id, role, email, full_name, is_active").eq("id", userId).maybeSingle();
    if (!target || target.account_id !== accountId) return json({ ok: false, error: "That person isn't on your team." }, 404);
    if (action === "resend_invite") {
      const { error } = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo: `${DASH_URL}/?invited=1`, data: { full_name: target.full_name } });
      if (error) {
        // Already-confirmed users can't be re-invited; send a password reset instead.
        const { error: e2 } = await admin.auth.resetPasswordForEmail(target.email, { redirectTo: `${DASH_URL}/?invited=1` });
        if (e2) return json({ ok: false, error: "Couldn't send the email. Try again in a few minutes." });
      }
      return json({ ok: true, sent: true });
    }
    if (target.id === callerId) return json({ ok: false, error: "You can't deactivate yourself." });
    if (target.role === "owner") return json({ ok: false, error: "The owner can't be deactivated." });
    const active = action === "reactivate";
    const { error: bErr } = await admin.auth.admin.updateUserById(target.id, { ban_duration: active ? "none" : "876000h" });
    if (bErr) return json({ ok: false, error: "Couldn't update the login. Try again." });
    await admin.from("users").update({ is_active: active, deactivated_at: active ? null : new Date().toISOString(), is_bookable: active ? undefined : false }).eq("id", target.id);
    if (!active) { try { await admin.auth.admin.signOut(target.id as any); } catch { /* sessions expire on their own */ } }
    await logActivity(accountId, callerId, active ? "user.reactivate" : "user.deactivate", "user", target.id, target.full_name);
    return json({ ok: true, is_active: active });
  }

  // ---- create ------------------------------------------------------------------------------------
  const fullName = String(body?.full_name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const invite = body?.invite === true;
  const isBookable = body?.is_bookable !== false;
  const role = body?.role === "admin" ? "admin" : "member";
  const title = String(body?.title || "").trim() || defaultTitle(acct, role);
  const phone = String(body?.phone || "").trim() || null;

  if (!fullName) return json({ ok: false, error: "Enter the person's name." });
  if (!emailOk(email)) return json({ ok: false, error: "Enter a valid login email." });
  if (!invite && password.length < 8) return json({ ok: false, error: "Password must be at least 8 characters, or send an invite instead." });

  const { data: existing } = await admin.from("users").select("id").ilike("email", email).maybeSingle();
  if (existing) return json({ ok: false, error: "That email is already in use." });

  const inviteToken = "staff_" + crypto.randomUUID().replace(/-/g, "");
  const { error: invErr } = await admin.from("staff_invites").insert({
    token: inviteToken, account_id: accountId, email, full_name: fullName, role, is_bookable: isBookable, created_by: callerId,
  });
  if (invErr) return json({ ok: false, error: "Could not start. Try again." });

  const meta = { staff_token: inviteToken, full_name: fullName, title, phone: phone || undefined };
  let createdId: string | null = null; let cErr: any = null;
  if (invite) {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: meta, redirectTo: `${DASH_URL}/?invited=1` });
    createdId = data?.user?.id || null; cErr = error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
    createdId = data?.user?.id || null; cErr = error;
  }
  if (cErr || !createdId) {
    await admin.from("staff_invites").delete().eq("token", inviteToken);
    const msg = String(cErr?.message || "").toLowerCase();
    if (msg.includes("already")) return json({ ok: false, error: "That email is already registered." });
    if (msg.includes("rate") || msg.includes("limit")) return json({ ok: false, error: "Email limit reached for the moment. Use a temporary password instead, or try again in an hour." });
    return json({ ok: false, error: "Could not create the login. Try again." });
  }

  const { data: staffUser } = await admin.from("users").select("id, account_id, role, is_bookable, full_name, title").eq("id", createdId).maybeSingle();
  if (!staffUser || staffUser.account_id !== accountId) {
    return json({ ok: false, error: "Login created but the team record looks off. Refresh the list.", user_id: createdId });
  }
  if (phone) await admin.from("users").update({ phone }).eq("id", createdId);
  await logActivity(accountId, callerId, "user.create", "user", createdId, fullName, { role: staffUser.role, invited: invite });
  return json({ ok: true, user_id: createdId, email, full_name: fullName, is_bookable: staffUser.is_bookable, role: staffUser.role, title: staffUser.title, invited: invite });
});
