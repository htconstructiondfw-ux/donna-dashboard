import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — knowledge lookup (Retell custom function) v20 (reads up to 6 passages from both searches; see MAX_PASSAGES). v18: outbound calls (wizard test call) resolve the business by the FROM number.
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
// v20: Donna reads more before answering. Both searches run every time (meaning + keywords) and are merged,
// up to MAX_PASSAGES passages; a long passage is cut to the window that best matches the question instead of
// its first 480 characters (the answer in a page-long passage of governing documents is rarely at the top).
const MAX_PASSAGES = 6;
const PASSAGE_CAP = 750;
const LEAD = "Passages from the business's knowledge that may answer the caller. Use them only if one actually answers the question, and say only what it states. If none does, say you are not certain and offer to take a message.\n\n";
const STOP = new Set("what when where which who whom how why are is was were the a an and or of for to in on at my our your their this that there does do did can could would should will may about with from have has had not any some much many long let get got tell know need want please rules rule community property".split(" "));

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
const squash = (t: string) => (t || "").replace(/\s+/g, " ").trim();
function stems(question: string, rare?: string[]): string[] {
  if (rare && rare.length) return rare.filter((x) => x && x.length >= 3).slice(0, 6);
  const out: string[] = [];
  for (const w of question.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || STOP.has(w)) continue;
    const cut = w.replace(/(ing|ed|es|s)$/, ""); const st = cut.length >= 4 ? cut : w;
    if (!out.includes(st)) out.push(st);
  }
  return out.slice(0, 8);
}
// Cut a long passage to the PASSAGE_CAP window that holds the most (and the rarest-first) question words.
function excerpt(text: string, keys: string[]): string {
  const t = squash(text);
  if (t.length <= PASSAGE_CAP) return t;
  const low = t.toLowerCase();
  const marks: { at: number; w: number }[] = [];
  keys.forEach((k, i) => { const wgt = keys.length - i; let from = 0; for (let n = 0; n < 40; n++) { const at = low.indexOf(k, from); if (at < 0) break; marks.push({ at, w: wgt }); from = at + k.length; } });
  let start = 0;
  if (marks.length) {
    let best = -1;
    for (const m of marks) {
      const s0 = Math.max(0, m.at - 200); const e0 = s0 + PASSAGE_CAP;
      const seen = new Set<number>(); let sc = 0;
      for (const x of marks) if (x.at >= s0 && x.at < e0) { sc += seen.has(x.w) ? 0.2 : x.w; seen.add(x.w); }
      if (sc > best) { best = sc; start = s0; }
    }
  }
  if (start > 0) { const sp = t.indexOf(" ", start); if (sp > 0 && sp - start < 40) start = sp + 1; }
  let out = t.slice(start, start + PASSAGE_CAP);
  if (start + PASSAGE_CAP < t.length) { const sp = out.lastIndexOf(" "); if (sp > PASSAGE_CAP * 0.8) out = out.slice(0, sp); out += "…"; }
  return (start > 0 ? "…" : "") + out;
}
function pack(rows: { title?: string; text: string }[]): string {
  return LEAD + rows.slice(0, MAX_PASSAGES).map((r) => (r.title ? `${r.title}: ${r.text}` : r.text)).join("\n\n");
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

  // Meaning search and keyword search run together; results are interleaved (best of each first) and de-duplicated.
  const [semRows, kwRows] = await Promise.all([
    (async () => {
      const vec = await embed(question);
      if (!vec) return [] as any[];
      const { data: rows } = await supabase.rpc("match_knowledge", { p_account_id: asst.account_id, p_query: vec, p_count: 8, p_property_id: propertyId });
      return (rows ?? []).filter((r: any) => (r.similarity ?? 0) >= SIM_THRESHOLD);
    })().catch(() => [] as any[]),
    (async () => {
      const { data: kw } = await supabase.rpc("donna_search_knowledge_any", { p_account_id: asst.account_id, p_query: question, p_limit: 5, p_property_id: propertyId });
      return kw ?? [];
    })().catch(() => [] as any[]),
  ]);
  const qKeys = stems(question);
  const picked: { title?: string; text: string }[] = []; const seen = new Set<string>();
  const add = (r: any, keys: string[]) => { if (!r || picked.length >= MAX_PASSAGES) return; const id = squash(r.content).slice(0, 160); if (seen.has(id)) return; seen.add(id); picked.push({ title: r.title || undefined, text: excerpt(r.content, keys) }); };
  for (let i = 0; i < 8 && picked.length < MAX_PASSAGES; i++) {
    if (semRows[i]) add(semRows[i], qKeys);
    if (kwRows[i]) add(kwRows[i], stems(question, kwRows[i].rare_terms));
  }
  if (picked.length) return json({ result: pack(picked) });

  return json({ result: NO_INFO });
});
