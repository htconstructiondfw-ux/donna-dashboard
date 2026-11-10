import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — Microsoft OAuth callback (v21). Requests Teams online-meeting permission for the company calendar so it can also be the video provider.
// state = a one-time nonce from donna_calendar_oauth_start (oauth_states) naming the account, the person and
// the scope: 'company' (the business calendar, calendar_connections) or 'user' (that person's own calendar,
// user_calendar_connections). A bare account id is still accepted as a company connection (older pages).
// Company: stacks connections keyed by account email; the FIRST calendar connected (or reconnecting the active
// one) becomes active; an ADDITIONAL account is added parked. Never clobbers an existing refresh token or
// calendar choice on reconnect.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const REDIRECT_URI = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/microsoft-oauth-callback";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE_COMPANY = "offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read https://graph.microsoft.com/OnlineMeetings.ReadWrite";
const SCOPE_USER = "offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, msg: string) {
  return new Response(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="font-family:system-ui;text-align:center;padding:48px;color:#111">` +
    `<h2>${title}</h2><p style="color:#444">${msg}</p><p style="color:#888">You can close this window.</p>` +
    `</body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

function redirectTo(base: string, params: string) {
  const url = base.replace(/\/$/, "") + "/?" + params;
  return new Response(null, { status: 302, headers: { Location: url } });
}

async function msEmail(token: string): Promise<string> {
  try {
    const r = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { "Authorization": `Bearer ${token}` } });
    if (!r.ok) return "";
    const d: any = await r.json();
    return d.mail || d.userPrincipalName || "";
  } catch { return ""; }
}

async function resolveState(state: string): Promise<{ account_id: string; user_id: string | null; scope: string } | null> {
  const { data: st } = await supabase.from("oauth_states").select("account_id, user_id, scope, created_at").eq("nonce", state).maybeSingle();
  if (st) {
    await supabase.from("oauth_states").delete().eq("nonce", state);
    if (Date.now() - new Date((st as any).created_at).getTime() > 30 * 60 * 1000) return null;
    return { account_id: (st as any).account_id, user_id: (st as any).user_id, scope: (st as any).scope };
  }
  if (UUID.test(state)) { const { data: a } = await supabase.from("accounts").select("id").eq("id", state).maybeSingle(); if (a) return { account_id: state, user_id: null, scope: "company" }; }
  return null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  const { data: secrets } = await supabase
    .from("app_secrets").select("key,value")
    .in("key", ["microsoft_client_id", "microsoft_client_secret", "app_base_url", "cron_secret"]);
  const map: Record<string, string> = Object.fromEntries((secrets ?? []).map((r: any) => [r.key, r.value]));
  const base = map["app_base_url"];
  const fail = (_r: string, msg: string) => base ? redirectTo(base, "calendar=error") : page("Could not connect", msg);

  if (err) return fail(err, `Microsoft returned: ${err}`);
  if (!code || !state) return fail("missing", "No authorization code or account was provided.");
  const who = await resolveState(state);
  if (!who) return fail("state", "This connection link expired. Start again from the dashboard.");
  const clientId = map["microsoft_client_id"]; const clientSecret = map["microsoft_client_secret"];
  if (!clientId || !clientSecret) return fail("config", "Microsoft calendar isn't configured yet.");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code", scope: who.scope === "user" ? SCOPE_USER : SCOPE_COMPANY }),
  });
  const tok: any = await tokenRes.json();
  if (!tokenRes.ok) return fail("token", `Token exchange failed: ${tok.error ?? "unknown"} ${tok.error_description ?? ""}`);

  const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
  const email = (tok.access_token ? await msEmail(tok.access_token) : "") || "unknown@microsoft";
  const now = new Date().toISOString();

  // ---- a person's own calendar ----
  if (who.scope === "user" && who.user_id) {
    const { data: prev } = await supabase.from("user_calendar_connections").select("provider, external_account, refresh_token").eq("user_id", who.user_id).maybeSingle();
    const same = !!prev && (prev as any).provider === "microsoft" && (prev as any).external_account === email;
    const refresh = tok.refresh_token || (same ? (prev as any).refresh_token : null);
    if (!refresh) return fail("refresh", "Microsoft didn't grant offline access. Try connecting again.");
    if (prev && !same) {
      // A different calendar than before: forget the old mirror and the busy time pulled from it.
      await supabase.from("calendar_blocks").delete().eq("user_id", who.user_id).eq("source", "calendar");
      await supabase.from("appointments").update({ user_event_id: null, user_event_user: null, user_sync_status: null }).eq("user_event_user", who.user_id);
    }
    const { error: upErr } = await supabase.from("user_calendar_connections").upsert({
      account_id: who.account_id, user_id: who.user_id, provider: "microsoft", external_account: email, calendar_id: "primary",
      access_token: tok.access_token ?? null, refresh_token: refresh, token_expires_at: expiresAt, status: "connected", last_error: null, last_pulled_at: null, updated_at: now,
    }, { onConflict: "user_id" });
    if (upErr) return fail("save", upErr.message);
    // First sync right away (appointments onto the calendar, busy time back), without holding up the redirect.
    try { const first = fetch(`${SELF}/user-calendar`, { method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": map["cron_secret"] || "" }, body: JSON.stringify({ action: "sweep", user_id: who.user_id, force: true }) }).catch(() => {}); (globalThis as any).EdgeRuntime?.waitUntil?.(first); } catch { /* */ }
    if (base) return redirectTo(base, "calendar=connected&mine=1");
    return page("Outlook calendar connected", "Your Donna appointments will show up on your calendar, and Donna won't book you when you're busy.");
  }

  // ---- the company calendar ----
  const acct = who.account_id;
  const { data: activeRows } = await supabase.from("calendar_connections").select("provider, external_account").eq("account_id", acct).eq("status", "connected").limit(1);
  const active = activeRows?.[0] as any;
  const makeActive = !active || (active.provider === "microsoft" && active.external_account === email);

  if (makeActive) {
    await supabase.from("calendar_connections").update({ status: "inactive", is_active: false, updated_at: now }).eq("account_id", acct).eq("status", "connected");
    await supabase.from("calendar_connections").update({ is_active: false }).eq("account_id", acct);
  }

  const payload: Record<string, unknown> = {
    account_id: acct, provider: "microsoft", external_account: email,
    access_token: tok.access_token ?? null, token_expires_at: expiresAt,
    status: makeActive ? "connected" : "inactive", last_error: null, is_active: makeActive, updated_at: now,
  };
  if (tok.refresh_token) payload.refresh_token = tok.refresh_token;

  const { error: upErr } = await supabase.from("calendar_connections").upsert(payload, { onConflict: "account_id,provider,external_account" });
  if (upErr) return fail("save", upErr.message);

  if (base) return redirectTo(base, "calendar=connected");
  return page("Microsoft Calendar connected", makeActive ? "Donna can now check your availability and add bookings to your Outlook calendar." : "Added. Open the dashboard and Make it active when you want Donna to use it.");
});
