import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { franc } from "https://esm.sh/franc@6";

// Donna — retell-call-events (v22). Retell's call_started / call_ended / call_analyzed webhook → calls row,
// transcript, language. v20: honors Retell's `direction`; an OUTBOUND call (Donna dialing out) is attributed to the
// account that owns the FROM number and logged as direction "outbound". Before, every call was resolved by the called
// number and stamped "inbound", which dropped outbound calls (customer numbers never match an assistant) and, when one
// Donna number called another, logged the outbound leg under the callee. v22: transcript lines are upserted against a unique
// (call, speaker, said_at) index, so call_ended and call_analyzed landing together can no longer double them.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// --- Retell request-signature gate (shared). Log-only until RETELL_SIG_ENFORCE=true. ---
const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
async function retellSigValid(rawBody: string, sigHeader: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sigHeader) return false;
  const m = String(sigHeader).match(/v=(\d+),d=(.*)/);
  if (!m) return false;
  const ts = m[1];
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody + ts));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const provided = (m[2] || "").trim().toLowerCase();
    if (expected.length !== provided.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
  } catch (e) { console.error("retell sig verify threw", String(e)); return false; }
}
async function retellGate(req: Request, label: string): Promise<{ reject: Response | null }> {
  let rawBody = "";
  try { rawBody = await req.clone().text(); } catch { rawBody = ""; }
  const valid = await retellSigValid(rawBody, req.headers.get("x-retell-signature"));
  console.log(`retell-sig ${label}: ${valid ? "PASS" : "FAIL"}`);
  if (!valid && RETELL_SIG_ENFORCE) {
    return { reject: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  }
  return { reject: null };
}
// --- end Retell gate ---

const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });

const ISO1_TO_3: Record<string, string> = {
  en: "eng", es: "spa", fr: "fra", de: "deu", ru: "rus", ar: "arb", hi: "hin",
  zh: "cmn", yue: "yue", vi: "vie", fa: "pes", pt: "por", it: "ita", ja: "jpn",
  ko: "kor", nl: "nld", th: "tha",
};
const ISO3_TO_NAME: Record<string, string> = {
  eng: "English", spa: "Spanish", fra: "French", deu: "German", rus: "Russian",
  arb: "Arabic", ara: "Arabic", hin: "Hindi", cmn: "Mandarin", zho: "Mandarin",
  yue: "Cantonese", vie: "Vietnamese", pes: "Persian", fas: "Persian",
  por: "Portuguese", ita: "Italian", jpn: "Japanese", kor: "Korean",
  nld: "Dutch", tha: "Thai",
};

function scriptDetect(t: string): string | null {
  if (/[ऀ-ॿ]/.test(t)) return "Hindi";
  if (/[Ѐ-ӿ]/.test(t)) return "Russian";
  if (/[가-힣]/.test(t)) return "Korean";
  if (/[぀-ヿ]/.test(t)) return "Japanese";
  if (/[฀-๿]/.test(t)) return "Thai";
  if (/[؀-ۿ]/.test(t)) return "Persian";
  if (/[一-鿿]/.test(t)) return "Mandarin";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return ok();
  const _gate = await retellGate(req, "call-events");
  if (_gate.reject) return _gate.reject;
  let body: any = {};
  try { body = await req.json(); } catch { return ok(); }

  const event = body?.event;
  const call = body?.call ?? {};
  const toNumber = call?.to_number ?? null;
  const fromNumber = call?.from_number ?? null;
  const retellId = call?.call_id;
  if (!event || !retellId || (!toNumber && !fromNumber)) return ok();

  // Donna's side of the call owns the record. Retell reports direction from Donna's point of view.
  const direction: "inbound" | "outbound" = call?.direction === "outbound" ? "outbound" : "inbound";
  const donnaNumber = direction === "outbound" ? fromNumber : toNumber;
  const otherParty = direction === "outbound" ? toNumber : fromNumber;
  if (!donnaNumber) return ok();

  const { data: asst } = await supabase
    .from("assistants").select("id, account_id, languages")
    .eq("twilio_number", donnaNumber).maybeSingle();
  if (!asst) return ok();

  const enabled: string[] = Array.isArray(asst.languages) && asst.languages.length ? asst.languages : ["en"];
  const only3 = enabled.map((c) => ISO1_TO_3[c]).filter(Boolean);

  const { data: existing } = await supabase
    .from("calls").select("id, language").eq("twilio_call_sid", retellId).maybeSingle();
  let callRowId: string | null = existing?.id ?? null;

  const startedAt = call.start_timestamp ? new Date(call.start_timestamp).toISOString() : new Date().toISOString();
  const startMs = call.start_timestamp ?? Date.parse(startedAt);

  async function ensureRow(patch: Record<string, unknown>) {
    if (callRowId) {
      await supabase.from("calls").update(patch).eq("id", callRowId);
    } else {
      const base = {
        account_id: asst.account_id, assistant_id: asst.id, twilio_call_sid: retellId,
        direction, from_number: fromNumber, to_number: toNumber, started_at: startedAt,
      };
      const { data: ins } = await supabase.from("calls").insert({ ...base, ...patch }).select("id").maybeSingle();
      callRowId = ins?.id ?? null;
    }
  }

  async function writeTranscript() {
    if (!callRowId) return;
    const arr = Array.isArray(call.transcript_object) ? call.transcript_object : [];
    if (arr.length === 0) return;
    // No delete: lines are unique per (call, speaker, said_at), so concurrent writers simply skip what's already there.
    const rows = arr.map((u: any, i: number) => {
      const role = u.role === "agent" ? "donna" : (u.role === "user" ? "caller" : "system");
      const off = u.words?.[0]?.start;
      const said = (typeof off === "number")
        ? new Date(startMs + off * 1000).toISOString()
        : new Date(startMs + i * 1000).toISOString();
      return { account_id: asst.account_id, call_id: callRowId, speaker: role, text: String(u.content ?? ""), said_at: said };
    }).filter((r: any) => r.text.trim().length > 0);
    if (rows.length) await supabase.from("transcript_messages").upsert(rows, { onConflict: "call_id,speaker,said_at", ignoreDuplicates: true });
  }

  function callerText(): string {
    const arr = Array.isArray(call.transcript_object) ? call.transcript_object : [];
    const user = arr.filter((u: any) => u?.role === "user").map((u: any) => String(u?.content || "")).join(" ").trim();
    if (user) return user;
    return typeof call.transcript === "string" ? call.transcript : "";
  }
  function detectSpoken(): string | null {
    const text = callerText();
    if (!text) return null;
    const byScript = scriptDetect(text);
    if (byScript) return byScript;
    try {
      const opts: any = { minLength: 6 };
      if (only3.length > 1) opts.only = only3;
      const code3 = franc(text, opts);
      if (code3 && code3 !== "und") return ISO3_TO_NAME[code3] || null;
    } catch (_e) { /* ignore */ }
    return null;
  }

  // End-of-call backstop. The mid-call retell-set-language function is the primary
  // save (survives hang-ups); this catches anything it missed. Upserts so a caller
  // with no record yet still gets their language saved.
  async function persistLanguage() {
    const spoken = detectSpoken();
    if (!spoken) return;
    if (callRowId) await supabase.from("calls").update({ language: spoken }).eq("id", callRowId);
    if (otherParty) {
      try { await supabase.rpc("upsert_contact_language", { p_account_id: asst.account_id, p_phone: otherParty, p_language: spoken }); } catch (_e) { /* best effort */ }
    }
  }

  if (event === "call_started") {
    await ensureRow({ status: "in_progress", started_at: startedAt });
  } else if (event === "call_ended") {
    const dur = call.duration_ms ? Math.round(call.duration_ms / 1000) : null;
    await ensureRow({
      status: "completed",
      ended_at: call.end_timestamp ? new Date(call.end_timestamp).toISOString() : new Date().toISOString(),
      duration_seconds: dur,
    });
    await writeTranscript();
    await persistLanguage();
  } else if (event === "call_analyzed") {
    const summary = call.call_analysis?.call_summary ?? null;
    await ensureRow({ summary, recording_url: call.recording_url ?? null });
    await writeTranscript();
    await persistLanguage();
    if (callRowId) {
      fetch("https://hingbdtmxozbjetzwibj.supabase.co/functions/v1/donna-learn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: callRowId }),
      }).catch(() => {});
    }
  }

  return ok();
});
