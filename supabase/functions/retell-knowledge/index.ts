import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — knowledge lookup (Retell custom function) v18: outbound calls (wizard test call) resolve the business by the FROM number.
// Donna calls this mid-call when a caller asks about the business. We identify
// the business by the dialed number, then search that account's knowledge by
// MEANING (gte-small embedding + vector similarity). If nothing is confident
// enough, we fall back to keyword search, then to taking a message — never a
// guess. For property management, the agent passes property_id (from pm-request
// identify) so a caller gets THAT community's rules, never another community's;
// account-wide entries (no property) always apply.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

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

const NO_INFO =
  "NO_INFO: You don't have this information. Do not guess. Offer to take a message and collect the caller's name, number, and what they need.";
const SIM_THRESHOLD = 0.78;
const MAX_PASSAGES = 2;
const PASSAGE_CAP = 480;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function trim(text: string): string {
  const t = (text || "").trim();
  if (t.length <= PASSAGE_CAP) return t;
  const slice = t.slice(0, PASSAGE_CAP);
  const stop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  return stop > PASSAGE_CAP * 0.5 ? slice.slice(0, stop + 1) : slice.trim() + "…";
}
function pack(rows: any[]): string {
  return rows.slice(0, MAX_PASSAGES).map((r: any) => (r.title ? `${r.title}: ${trim(r.content)}` : trim(r.content))).join("\n\n");
}
async function embed(text: string): Promise<string | null> {
  try {
    const session = new (globalThis as any).Supabase.ai.Session("gte-small");
    const emb: number[] = await session.run(text, { mean_pool: true, normalize: true });
    if (!Array.isArray(emb) || !emb.length) return null;
    return "[" + emb.join(",") + "]";
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ result: "" }, 405);
  const _gate = await retellGate(req, "knowledge");
  if (_gate.reject) return _gate.reject;

  let body: any = {};
  try { body = await req.json(); } catch { return json({ result: NO_INFO }); }

  const call = body?.call ?? {};
  const args = body?.args ?? {};
  // On an OUTBOUND call (Donna dialing the owner for the wizard test call) Donna's number is the FROM side.
  const toNumber = call?.direction === "outbound" ? call?.from_number : call?.to_number;
  const question = String(args?.question ?? args?.query ?? "").trim();
  const propertyId = String(args?.property_id ?? "").trim() || null;
  if (!toNumber || !question) return json({ result: NO_INFO });

  const { data: asst } = await supabase
    .from("assistants").select("account_id").eq("twilio_number", toNumber).maybeSingle();
  if (!asst) return json({ result: NO_INFO });

  const vec = await embed(question);
  if (vec) {
    const { data: rows } = await supabase.rpc("match_knowledge", { p_account_id: asst.account_id, p_query: vec, p_count: 4, p_property_id: propertyId });
    const good = (rows ?? []).filter((r: any) => (r.similarity ?? 0) >= SIM_THRESHOLD);
    if (good.length) return json({ result: pack(good) });
  }

  const { data: kw } = await supabase.rpc("donna_search_knowledge", { p_account_id: asst.account_id, p_query: question, p_limit: 3, p_property_id: propertyId });
  if (kw && kw.length) return json({ result: pack(kw) });

  return json({ result: NO_INFO });
});
