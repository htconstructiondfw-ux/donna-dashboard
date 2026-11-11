import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna voice lab (v1). Cron-secret gated, admin only.
//  voices                -> list Retell voices ({provider?, limit?})
//  agent / agent_patch   -> read / patch whitelisted delivery settings on the shared agent (never voice_id or language)
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") || "";
const AGENT_ID = Deno.env.get("RETELL_AGENT_ID") || "agent_7e8792e07df78b6e366decb52a";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const rh = () => ({ Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const { data: secretRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
  const cronSecret = (secretRow as any)?.value || "";
  if (!cronSecret || (req.headers.get("x-cron-secret") || "") !== cronSecret) return json({ ok: false, reason: "forbidden" }, 403);
  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const action = String(body.action || "agent");
  if (action === "voices") {
    const vr = await fetch("https://api.retellai.com/list-voices", { headers: rh() });
    const vs: any = await vr.json().catch(() => []);
    if (!vr.ok) return json({ ok: false, step: "list-voices", status: vr.status, body: vs });
    const want = String(body.provider || "").toLowerCase();
    const out = (Array.isArray(vs) ? vs : []).filter((v: any) => !want || String(v.provider || "").toLowerCase() === want)
      .filter((v: any) => !body.lang || String(v.accent || "").toLowerCase().includes("american") || !v.accent)
      .map((v: any) => ({ id: v.voice_id, name: v.voice_name, provider: v.provider, gender: v.gender, accent: v.accent, age: v.age }));
    return json({ ok: true, count: out.length, voices: out.slice(0, Number(body.limit || 400)) });
  }
  if (action === "agent" || action === "agent_patch") {
    const gr = await fetch(`https://api.retellai.com/get-agent/${AGENT_ID}`, { headers: rh() });
    const ag: any = await gr.json().catch(() => ({}));
    if (!gr.ok) return json({ ok: false, step: "get-agent", status: gr.status, body: ag });
    const KEYS = ["voice_id", "voice_model", "voice_temperature", "voice_speed", "volume", "responsiveness", "interruption_sensitivity", "enable_backchannel", "backchannel_frequency", "backchannel_words", "ambient_sound", "ambient_sound_volume", "language", "normalize_for_speech", "begin_message_delay_ms", "fallback_voice_ids", "denoising_mode", "max_call_duration_ms", "end_call_after_silence_ms"];
    const pick = (o: any) => Object.fromEntries(KEYS.filter((k) => k in (o || {})).map((k) => [k, o[k]]));
    if (action === "agent") return json({ ok: true, agent: pick(ag) });
    const patch = pick(body.patch || {}); delete (patch as any).voice_id; delete (patch as any).language;
    if (!Object.keys(patch).length) return json({ ok: false, error: "nothing to patch" });
    if (body.dry_run) return json({ ok: true, dry_run: true, before: pick(ag), patch });
    const ur = await fetch(`https://api.retellai.com/update-agent/${AGENT_ID}`, { method: "PATCH", headers: rh(), body: JSON.stringify(patch) });
    const up: any = await ur.json().catch(() => ({}));
    if (!ur.ok) return json({ ok: false, step: "update-agent", status: ur.status, body: up });
    return json({ ok: true, before: pick(ag), after: pick(up) });
  }

  return json({ ok: false, error: "unknown action" });
});
