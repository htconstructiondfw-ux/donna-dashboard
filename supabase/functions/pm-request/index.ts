import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — Property Management brain (phone / email / text + dashboard-triggered sends).
// Every property has a TYPE (residential / commercial / hoa) and Donna runs that property's playbook.
// Actions: identify, status, log, emergency, arc, violation, resale_cert, hvac_afterhours, access, account,
//          amenity_list, amenity_reserve, insurance, coi_status, coi_send, upcoming, rsvp; GET ?ack=<token>.
// v16: the property's assigned manager (properties.manager_user_id, or its community's) is paged first on emergencies.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = `${SUPABASE_URL}/functions/v1`;
const PUBLIC_BASE = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-donna-secret, x-retell-signature",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
function json(obj: unknown, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } }); }
function html(body: string, status = 200) { return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } }); }
const esc = (s: unknown) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pick = (v: unknown) => { const s = (v == null ? "" : String(v)).trim(); return s.length ? s : ""; };
const truthy = (v: unknown) => { if (v === true) return true; const s = String(v ?? "").trim().toLowerCase(); return ["true","yes","1","urgent","emergency"].includes(s); };
const normPhone = (s: unknown) => String(s ?? "").replace(/[^0-9+]/g, "");
const shortRef = () => "SR-" + Array.from(crypto.getRandomValues(new Uint8Array(3))).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const tok = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function addBusinessDays(from: Date, n: number): Date { const d = new Date(from); let added = 0; while (added < n) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) added++; } return d; }
function parseWhen(input: string, tz: string): Date | null {
  const s = pick(input); if (!s) return null;
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(s) || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  const guess = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(guess.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(guess);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
    const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
    return new Date(guess.getTime() - (asLocal - guess.getTime()));
  } catch { return guess; }
}
function fmtDate(iso: string | Date, tz: string) { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(iso)); } catch { return String(iso); } }
function fmtWhen(iso: string | Date, tz: string) { try { const d = new Date(iso); return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(d) + " at " + new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d); } catch { return String(iso); } }

const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
async function retellSigValid(rawBody: string, sigHeader: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sigHeader) return false;
  const m = String(sigHeader).match(/v=(\d+),d=(.*)/);
  if (!m) return false;
  if (Math.abs(Date.now() - Number(m[1])) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody + m[1]));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const provided = (m[2] || "").trim().toLowerCase();
    if (expected.length !== provided.length) return false;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return diff === 0;
  } catch (_e) { return false; }
}

async function resolveAccount(req: Request, rawBody: string, body: any): Promise<{ account_id: string | null; channel: string }> {
  const call = body?.call ?? {};
  const toNumber = pick(call?.direction === "outbound" ? call?.from_number : call?.to_number); // outbound = wizard test call
  if (toNumber) {
    const valid = await retellSigValid(rawBody, req.headers.get("x-retell-signature"));
    if (!valid && RETELL_SIG_ENFORCE) return { account_id: null, channel: "phone" };
    const { data: asst } = await supabase.from("assistants").select("account_id").eq("twilio_number", toNumber).maybeSingle();
    return { account_id: asst?.account_id ?? null, channel: "phone" };
  }
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer && bearer === SERVICE_ROLE) return { account_id: pick(body?.account_id) || null, channel: pick(body?.channel) || "manual" };
  if (bearer) {
    try {
      const { data: u } = await supabase.auth.getUser(bearer);
      const uid = u?.user?.id;
      if (uid) { const { data: urow } = await supabase.from("users").select("account_id").eq("id", uid).maybeSingle(); if (urow?.account_id) return { account_id: urow.account_id, channel: pick(body?.channel) || "manual" }; }
    } catch (_e) { /* fall through */ }
  }
  return { account_id: null, channel: "manual" };
}

// ---------- data helpers ----------
async function getAccount(accountId: string) { const { data } = await supabase.from("accounts").select("name, settings").eq("id", accountId).maybeSingle(); return data || { name: "the property office", settings: {} }; }
function typeTerms(t: string) { if (t === "hoa") return { resident: "homeowner", place: "community", manager: "community manager" }; if (t === "commercial") return { resident: "tenant", place: "building", manager: "property manager" }; return { resident: "resident", place: "property", manager: "property manager" }; }
const PROP_COLS = "id, name, property_type, require_tenant_insurance, timezone, emergency_instructions, address, community_structure, lease_type_default, after_hours_hvac, gate_access, board, association_insurance, vendor_coi_required, parent_property_id, board_approval_threshold, units_count";
async function listProperties(accountId: string) { const { data } = await supabase.from("properties").select(PROP_COLS).eq("account_id", accountId).eq("is_active", true).order("name"); return data || []; }
function matchProperty(props: any[], hint: string, idHint: string) {
  if (idHint) { const p = props.find((x) => x.id === idHint); if (p) return p; }
  const h = pick(hint).toLowerCase();
  if (h) { let p = props.find((x) => String(x.name).toLowerCase() === h); if (p) return p; const cands = props.filter((x) => String(x.name).toLowerCase().includes(h) || h.includes(String(x.name).toLowerCase())); if (cands.length) return rankMatches(cands, h)[0]; p = props.find((x) => x.address && String(x.address).toLowerCase().includes(h)); if (p) return p; }
  if (props.length === 1) return props[0];
  return null;
}
function matchPropertyStrict(props: any[], hint: string, idHint: string) {
  if (idHint) { const p = props.find((x) => x.id === idHint); if (p) return p; }
  const h = pick(hint).toLowerCase();
  if (!h) return null;
  let p = props.find((x) => String(x.name).toLowerCase() === h); if (p) return p;
  const cands = props.filter((x) => String(x.name).toLowerCase().includes(h) || h.includes(String(x.name).toLowerCase()));
  if (cands.length) return rankMatches(cands, h)[0];
  p = props.find((x) => x.address && String(x.address).toLowerCase().includes(h)); if (p) return p;
  const hw = normAddr(h).replace(/\b(the|hoa|community|association|apartments|building|at)\b/g, " ").split(/\s+/).filter((w) => w.length > 1);
  if (hw.length) { const c2 = props.filter((x) => { const n = normAddr(String(x.name).toLowerCase() + " " + String(x.address || "").toLowerCase()); return hw.every((w) => n.includes(w)); }); if (c2.length) return rankMatches(c2, h)[0]; }
  return null;
}
function normAddr(s: string) { return s.replace(/\bdrive\b/g, "dr").replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave").replace(/\broad\b/g, "rd").replace(/\blane\b/g, "ln").replace(/\bcourt\b/g, "ct").replace(/\bboulevard\b/g, "blvd").replace(/\bplace\b/g, "pl").replace(/\bcircle\b/g, "cir").replace(/[.,]/g, " "); }
function rankMatches(cands: any[], h: string) {
  return cands.slice().sort((a, b) => {
    const as = String(a.name).toLowerCase().startsWith(h) ? 0 : 1, bs = String(b.name).toLowerCase().startsWith(h) ? 0 : 1; if (as !== bs) return as - bs;
    const ap = a.parent_property_id ? 1 : 0, bp = b.parent_property_id ? 1 : 0; if (ap !== bp) return ap - bp;
    return String(a.name).length - String(b.name).length;
  });
}
function communityOf(props: any[], property: any) {
  if (!property) return null;
  if (property.property_type === "hoa") return property;
  if (property.parent_property_id) { const par = props.find((x) => x.id === property.parent_property_id); if (par && par.property_type === "hoa") return par; }
  return property;
}
async function findContact(accountId: string, phone: string, email: string) {
  if (phone) { const { data } = await supabase.from("contacts").select("id, name, preferred_name, phone, email").eq("account_id", accountId).eq("phone", phone).order("last_call_at", { ascending: false, nullsFirst: false }).limit(1); if (data && data[0]) return data[0]; }
  if (email) { const { data } = await supabase.from("contacts").select("id, name, preferred_name, phone, email").eq("account_id", accountId).ilike("email", email).limit(1); if (data && data[0]) return data[0]; }
  return null;
}
async function ensureContact(accountId: string, phone: string, email: string, name: string) {
  const c = await findContact(accountId, phone, email);
  if (c) { const patch: any = {}; if (name && !c.name) patch.name = name; if (email && !c.email) patch.email = email; if (phone && !c.phone) patch.phone = phone; if (Object.keys(patch).length) await supabase.from("contacts").update(patch).eq("id", c.id); return c; }
  const { data, error } = await supabase.from("contacts").insert({ account_id: accountId, phone: phone || null, email: email || null, name: name || null, preferred_name: name ? name.split(/\s+/)[0] : null, source: "donna", list_type: "normal" }).select("id, name, preferred_name, phone, email").maybeSingle();
  if (error) return null; return data;
}
async function contactLinks(accountId: string, contactId: string) { const { data } = await supabase.from("property_contacts").select("id, property_id, role, unit, company, authorized, properties(id, name, property_type, parent_property_id, community_structure, lease_type_default)").eq("account_id", accountId).eq("contact_id", contactId); return data || []; }
async function ensurePropertyContact(accountId: string, propertyId: string, contactId: string, role: string, unit: string, name: string, phone: string, email: string) {
  const { data } = await supabase.from("property_contacts").select("id, role, unit").eq("account_id", accountId).eq("property_id", propertyId).eq("contact_id", contactId).limit(1);
  if (data && data[0]) { const patch: any = {}; if (unit && !data[0].unit) patch.unit = unit; if (Object.keys(patch).length) await supabase.from("property_contacts").update(patch).eq("id", data[0].id); return data[0].id; }
  const { data: ins } = await supabase.from("property_contacts").insert({ account_id: accountId, property_id: propertyId, contact_id: contactId, role: role || "tenant", unit: unit || null, name: name || null, phone: phone || null, email: email || null }).select("id").maybeSingle();
  return ins?.id ?? null;
}

// ---------- the playbooks ----------
const COMMON_AREA_RE = /\b(pool|clubhouse|gate|entry gate|entrance|monument|common area|common-area|playground|tennis|court|sidewalk|street ?light|streetlight|private street|road|drain|storm|irrigation|sprinkler(s)? (in|on) the (common|median|entrance)|landscap|mailbox kiosk|cluster mailbox|dog park|pavilion|fence along|perimeter fence|parking lot|lobby|elevator|hallway|stairwell|roof|exterior|siding|foundation|retaining wall|dumpster|trash enclosure)\b/i;
const SHELL_RE = /\b(roof|exterior wall|siding|foundation|shared wall|common wall|stack|main line|slab leak|balcony structure|gutters?|exterior paint)\b/i;
const BASE_BUILDING_RE = /\b(roof|rooftop|hvac unit on the roof|rtu|chiller|boiler|elevator|fire (panel|alarm|sprinkler)|sprinkler system|lobby|parking|garage|common restroom|restroom in the hall|hallway|main water|water main|electrical room|transformer|building power|loading dock|dock door|building sign|pylon|exterior|structure|structural)\b/i;
const IN_UNIT_RE = /\b(my (sink|faucet|toilet|shower|tub|dishwasher|disposal|garbage disposal|fridge|refrigerator|oven|stove|microwave|washer|dryer|water heater|ac|a\/c|air conditioner|thermostat|furnace|heater|door lock|window|ceiling fan|light switch|outlet|breaker)|inside (my|the) (unit|home|house|apartment|suite)|in my (kitchen|bathroom|bedroom|living room|garage))\b/i;

function inferScope(type: string, structure: string | null, text: string, given: string): string {
  const g = pick(given).toLowerCase().replace(/[\s-]+/g, "_");
  if (["in_unit","common_area","base_building","tenant_space","shell"].includes(g)) return g;
  const t = text || "";
  if (type === "hoa") {
    if (COMMON_AREA_RE.test(t) && !IN_UNIT_RE.test(t)) return "common_area";
    if ((structure === "attached" || structure === "mixed") && SHELL_RE.test(t)) return "shell";
    return "in_unit";
  }
  if (type === "commercial") {
    if (BASE_BUILDING_RE.test(t) && !IN_UNIT_RE.test(t)) return "base_building";
    return "tenant_space";
  }
  return "in_unit";
}

function responsibility(property: any, scope: string): { ours: boolean; why: string; guidance: string } {
  const type = property?.property_type || "residential";
  const structure = property?.community_structure || "detached";
  if (type === "residential") return { ours: true, why: "rental: the manager handles repairs", guidance: "" };
  if (type === "commercial") {
    if (scope === "base_building" || scope === "common_area") return { ours: true, why: "base building is the landlord's", guidance: "" };
    const lease = property?.lease_type_default || "full_service";
    if (lease === "nnn") return { ours: false, why: "NNN lease: inside the suite is the tenant's", guidance: `Under the lease, repairs inside the suite are the tenant's responsibility. The office can share its approved vendor list, and anything affecting the building systems (roof, structure, HVAC on the roof, electrical room, fire/life safety) is handled by the building.` };
    return { ours: true, why: lease === "modified_gross" ? "modified gross: logged for the manager to confirm against the lease" : "full-service lease", guidance: "" };
  }
  if (scope === "common_area") return { ours: true, why: "common area belongs to the association", guidance: "" };
  if (scope === "shell" && (structure === "attached" || structure === "mixed")) return { ours: true, why: "attached community: the association maintains the building shell", guidance: "" };
  return { ours: false, why: "inside the home is the owner's responsibility", guidance: `The association maintains the common areas${(structure === "attached" || structure === "mixed") ? " and the building exterior, roof, and foundation" : ""}; repairs inside the home (plumbing, fixtures, appliances, heating and cooling${structure === "detached" ? ", roof, yard" : ""}) are the homeowner's. If you rent, your landlord handles those. If water is coming from a shared pipe, the roof, or a neighboring unit in an attached building, tell me and I'll log it for the association.` };
}

function routeChild(links: any[], property: any): any | null {
  if (!property || property.property_type !== "hoa") return null;
  const hit = links.find((l) => l.properties && l.properties.parent_property_id === property.id && l.properties.property_type !== "hoa");
  return hit ? hit.properties : null;
}

const EMERGENCY_MAP: [RegExp, string][] = [
  [/flood|burst|pipe|water every|water comi|leak(ing)?|overflow|sewage|sewer back/i, "flood"],
  [/gas|smell of gas|rotten egg/i, "gas"],
  [/carbon monoxide|co alarm|co detector/i, "fire"],
  [/no heat|heater|furnace|freezing/i, "no_heat"],
  [/no (a\/?c|air)|no cooling|ac (is )?out|air conditioning (is )?out/i, "no_ac"],
  [/fire|smoke|burning/i, "fire"],
  [/\bgate\b/i, "security"],
  [/elevator|trapped in|entrap|stuck in (the )?(elevator|lift)/i, "elevator"],
  [/hvac|chiller|boiler/i, "hvac"],
  [/break[- ]?in|intruder|security|broke in|burglar|door won'?t lock|can'?t secure/i, "security"],
  [/power|no electricity|outage|electrical|sparking/i, "power"],
];
function detectEmergencyType(text: string, given: string) {
  const g = pick(given).toLowerCase();
  if (g && ["flood","water","gas","no_heat","no_ac","fire","elevator","hvac","security","power","other"].includes(g)) return g === "water" ? "flood" : g;
  for (const [re, t] of EMERGENCY_MAP) if (re.test(text)) return t;
  return "other";
}
function safetySteps(emType: string): string {
  switch (emType) {
    case "gas": return "If you smell gas, leave the building now, don't flip switches or light anything, and call 911 and the gas company from outside.";
    case "fire": return "If there is fire, smoke, or a carbon monoxide alarm, get everyone out and call 911 first.";
    case "flood": return "If you can reach it safely, turn off the water at the fixture shut-off or the main valve, and move belongings out of the water.";
    case "power": return "If you see sparks or smell burning, stay away from it and call 911. For an outage, check the breaker and the utility's outage line.";
    case "elevator": return "If someone is in the elevator, have them stay calm, use the emergency button or intercom, and not force the doors.";
    default: return "";
  }
}
function responseWindow(type: string, reqType: string, priority: string) {
  if (priority === "emergency") return "right away";
  if (priority === "urgent") return "today";
  if (reqType === "arc") return "once the architectural committee reviews it";
  if (reqType === "amenity") return "shortly";
  if (reqType === "leasing") return "within one business day";
  if (reqType === "resale_cert") return "within ten business days as required";
  if (type === "commercial") return "within one business day";
  if (type === "hoa") return "within a few business days";
  return "within one to two business days";
}

// ---------- notifications ----------
async function resendEmail(from: string, to: string, subject: string, text: string, htmlBody: string) {
  if (!RESEND_KEY || !from || !to) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to: [to], subject, text, html: htmlBody }) });
      if (r.ok) return true;
      if (r.status === 429 || r.status >= 500) { await sleep(600); continue; }
      return false;
    } catch (_e) { await sleep(400); }
  }
  return false;
}
async function sendSms(accountId: string, to: string, body: string): Promise<boolean> {
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch (_e) { return false; }
}
async function pickEscalationContacts(accountId: string, propertyId: string | null, emType: string) {
  const { data } = await supabase.from("property_escalation_contacts").select("*").eq("account_id", accountId).eq("is_active", true);
  const all = data || [];
  const score = (c: any) => { let s = 0; if (propertyId && c.property_id === propertyId) s += 2; else if (!c.property_id) s += 1; else return -1; if (c.emergency_type === emType) s += 2; else if (c.emergency_type === "default") s += 1; else return -1; return s; };
  const ladder = all.map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0).sort((a, b) => (b.s - a.s) || (a.c.priority - b.c.priority)).map((x) => x.c);
  // Team: the property's assigned manager (or its community's) is paged first; the escalation ladder follows.
  const mgr = await propertyManager(propertyId);
  if (mgr && (mgr.phone || mgr.email) && !ladder.some((c) => (mgr.phone && c.phone === mgr.phone) || (mgr.email && c.email && c.email.toLowerCase() === String(mgr.email).toLowerCase()))) ladder.unshift({ name: mgr.full_name || "Property manager", email: mgr.email, phone: mgr.phone, priority: -1, source: "manager", user_id: mgr.id });
  return ladder;
}
// The active user who manages a property: its own manager_user_id, else the parent community's.
async function propertyManager(propertyId: string | null): Promise<any | null> {
  if (!propertyId) return null;
  const { data: p } = await supabase.from("properties").select("manager_user_id, parent_property_id").eq("id", propertyId).maybeSingle();
  let uid = p?.manager_user_id || null;
  if (!uid && p?.parent_property_id) { const { data: pp } = await supabase.from("properties").select("manager_user_id").eq("id", p.parent_property_id).maybeSingle(); uid = pp?.manager_user_id || null; }
  if (!uid) return null;
  const { data: u } = await supabase.from("users").select("id, full_name, email, phone, is_active").eq("id", uid).maybeSingle();
  return u && u.is_active !== false ? u : null;
}
async function notifyOnCall(opts: { account: any; property: any; recipient: any; caller: any; sr: any; emType: string; callback: string; business: string; }) {
  const { account, property, recipient, caller, sr, emType, callback, business } = opts;
  const settings: any = account.settings || {};
  const from = pick(settings.email_reply_from) || `${business} <no-reply@client.sidekicklogistics.com>`;
  const ackUrl = `${SELF}/pm-request?ack=${sr.ack_token}`;
  const propLine = property ? `${property.name}` : "(property not identified)";
  const callerName = caller?.name || "a caller";
  const subject = `EMERGENCY (${emType.replace(/_/g, " ")}) — ${propLine} [${sr.short_ref}]`;
  const lines = `Donna flagged an after-hours emergency.\n\nProperty: ${propLine}\nType: ${emType.replace(/_/g, " ")}\nUnit: ${sr.unit || "(n/a)"}\nFrom: ${callerName}${callback ? ` (${callback})` : ""}\nRef: ${sr.short_ref}\n\nWhat they reported:\n${sr.description || "(no detail)"}\n\nTap to confirm you've got it (otherwise Donna escalates to the next contact):\n${ackUrl}`;
  const htmlBody = `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px"><p style="background:#b00020;color:#fff;padding:10px 14px;border-radius:8px;font-weight:700;margin:0 0 14px">EMERGENCY flagged by Donna</p><table style="font-size:15px;border-collapse:collapse"><tr><td style="color:#555;padding:3px 12px 3px 0">Property</td><td><b>${esc(propLine)}</b></td></tr><tr><td style="color:#555;padding:3px 12px 3px 0">Type</td><td><b>${esc(emType.replace(/_/g," "))}</b></td></tr><tr><td style="color:#555;padding:3px 12px 3px 0">Unit</td><td>${esc(sr.unit || "(n/a)")}</td></tr><tr><td style="color:#555;padding:3px 12px 3px 0">From</td><td><b>${esc(callerName)}</b>${callback ? " (" + esc(callback) + ")" : ""}</td></tr><tr><td style="color:#555;padding:3px 12px 3px 0">Ref</td><td>${esc(sr.short_ref)}</td></tr></table><p style="margin:14px 0 4px;color:#555">Reported</p><p style="margin:0 0 16px;padding:12px;background:#f4f4f5;border-radius:8px;white-space:pre-wrap">${esc(sr.description || "(no detail)")}</p><p style="margin:0 0 16px"><a href="${ackUrl}" style="background:#0f7b3b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">I've got it</a></p><p style="margin:0;color:#777;font-size:13px">If no one confirms, Donna escalates to the next on-call contact automatically.</p></div>`;
  const results: string[] = [];
  if (recipient?.email) { if (await resendEmail(from, recipient.email, subject, lines, htmlBody)) results.push("email"); }
  if (recipient?.phone) { const smsText = `EMERGENCY ${propLine} [${sr.short_ref}] ${emType.replace(/_/g," ")}${sr.unit ? " unit " + sr.unit : ""}. ${(sr.description || "").slice(0, 90)}. Confirm: ${ackUrl}`; if (await sendSms(account.id, recipient.phone, smsText)) results.push("text"); }
  const box = pick(settings.alert_email);
  if (box && box.toLowerCase() !== String(recipient?.email || "").toLowerCase()) { await sleep(400); await resendEmail(from, box, subject, lines, htmlBody); }
  return results;
}
async function notifyOffice(account: any, business: string, subject: string, text: string) {
  try {
  const settings: any = account.settings || {}; const box = pick(settings.alert_email); if (!box) return false;
  const from = pick(settings.email_reply_from) || `${business} <no-reply@client.sidekicklogistics.com>`;
  return await resendEmail(from, box, subject, text, `<pre style="font-family:system-ui,Arial,sans-serif;white-space:pre-wrap;font-size:14px">${esc(text)}</pre>`);
  } catch (_e) { return false; }
}
async function matchAutoRule(accountId: string, propertyId: string | null, trade: string) {
  const t = pick(trade).toLowerCase(); if (!t) return null;
  const { data } = await supabase.from("dispatch_rules").select("*").eq("account_id", accountId).eq("auto", true);
  const rules = (data || []).filter((r: any) => { const rt = String(r.trade || "").toLowerCase(); return rt && (rt === t || t.includes(rt) || rt.includes(t)); });
  const scored = rules.map((r: any) => ({ r, s: r.property_id ? (r.property_id === propertyId ? 2 : -1) : 1 })).filter((x: any) => x.s >= 0).sort((a: any, b: any) => b.s - a.s);
  return scored[0]?.r || null;
}
async function autoDispatch(accountId: string, srId: string, contractorId: string) {
  try { const r = await fetch(`${SELF}/pm-dispatch`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "dispatch", account_id: accountId, service_request_id: srId, contractor_id: contractorId }) }); const j: any = await r.json().catch(() => ({})); return j?.ok ? j : null; } catch { return null; }
}

// ---------- caller context ----------
async function callerContext(accountId: string, props: any[], phone: string, email: string, propHint: string, propId: string) {
  const contact = await findContact(accountId, phone, email);
  let links: any[] = [];
  if (contact) links = await contactLinks(accountId, contact.id);
  let matched: any = null, link: any = null;
  if (propHint || propId) {
    const explicit = matchPropertyStrict(props, propHint, propId);
    if (explicit) { matched = explicit; link = links.find((l) => l.property_id === matched.id) || null; }
  }
  if (!matched && links.length === 1) { link = links[0]; matched = props.find((p) => p.id === link.property_id) || null; }
  if (!matched) { matched = matchProperty(props, propHint, propId); if (matched && links.length) link = links.find((l) => l.property_id === matched.id) || null; }
  const role = link?.role || null;
  const authorized = !!link?.authorized;
  const unit = link?.unit || null;
  const company = link?.company || null;
  return { contact, links, property: matched, role, authorized, unit, company };
}
function playbookFor(property: any, ctx: any, business: string): string {
  if (!property) return "No property identified yet. Ask which property or community this is about before anything else.";
  const t = property.property_type; const terms = typeTerms(t); const role = ctx.role;
  const lines: string[] = [];
  lines.push(`This is a ${t === "hoa" ? "community (HOA/condo)" : t === "commercial" ? "commercial / flex building" : "residential rental"}: use the words ${terms.resident}/${terms.place}.`);
  if (t === "hoa") {
    lines.push(`The association maintains common areas${(property.community_structure === "attached" || property.community_structure === "mixed") ? " and the building shell (roof, exterior, foundation)" : ""} only. Problems inside the home are the homeowner's (or their landlord's) — do NOT log those as association work orders; give guidance and offer to note it.`);
    lines.push(role === "owner" ? "Caller is an owner of record: may submit ARC requests, ask about their own account, request records." : role === "board" ? "Caller is a board member: board-level answers OK; still never disclose another owner's account/violation." : role === "tenant" ? "Caller is a renter of an owner: community questions only; repairs and account matters go to their landlord/owner." : "Caller's role is not confirmed: answer general community questions; for account, ARC, or gate codes, confirm they are the owner/resident of record first.");
    lines.push("Never confirm or deny another owner's violation or account status. Dues balances: point to the portal/manager unless verified owner. Resale certificates: collect requester, property address, buyer, closing date, email.");
    if (property.gate_access) lines.push("Gate/access info exists: release ONLY to a verified resident of this community (recognized phone/email or confirmed address).");
  } else if (t === "commercial") {
    lines.push(`Base building (roof, structure, rooftop HVAC, elevators, lobby, parking, fire/life safety) is ours. Inside the suite: ${property.lease_type_default === "nnn" ? "tenant's responsibility (NNN) — advise and offer the approved vendor list" : "ours under the lease — log it"}.`);
    lines.push(ctx.authorized ? `Caller is an AUTHORIZED contact${ctx.company ? " for " + ctx.company : ""}: may order billable work, after-hours HVAC, access cards.` : `Caller is NOT a confirmed authorized contact${ctx.company ? " for " + ctx.company : ""}: take any report, but billable work, after-hours HVAC, key/lock changes, and access must be confirmed by an authorized contact — say so.`);
    const hv = property.after_hours_hvac || {}; if (hv.enabled !== false) lines.push(`After-hours HVAC is available with ${hv.lead_hours || 48} hours' notice and is billable${hv.rate_note ? " (" + hv.rate_note + ")" : " per the lease"}.`);
  } else {
    lines.push("In-unit repairs are ours: log work orders with access/permission-to-enter. Try quick troubleshooting first for breakers, disposals, thermostats. Rent/payment: say where and how to pay, never take card numbers.");
    if (property.require_tenant_insurance) lines.push("Renters insurance is required here; offer the upload link if theirs isn't on file.");
  }
  if (property.emergency_instructions) lines.push("Property emergency instructions: " + property.emergency_instructions);
  return lines.join(" ");
}

function speakable(code: string): string {
  return String(code || "").replace(/\d{3,}/g, (m) => m.split("").join(" ")).replace(/#/g, " pound").replace(/\*/g, " star").replace(/\s+/g, " ").trim();
}
async function activeIncident(accountId: string, property: any) {
  if (!property) return null;
  const ids = [property.id].concat(property.parent_property_id ? [property.parent_property_id] : []);
  const { data } = await supabase.from("pm_incidents").select("id, title, message, eta, started_at, property_id").eq("account_id", accountId).in("property_id", ids).eq("is_active", true).order("started_at", { ascending: false }).limit(1);
  return data && data[0] ? data[0] : null;
}
function incidentMatches(inc: any, text: string): boolean {
  if (!inc) return false;
  const stop = new Set(["the","a","an","and","or","of","in","on","at","to","is","are","for","with","out","not","no","my","our","your","we","it","this","that","there","be","has","have","from","by","as"]);
  const words = (str: string) => String(str || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const incWords = new Set(words(inc.title + " " + inc.message));
  const hits = words(text).filter((w) => incWords.has(w));
  return hits.length >= 2 || (hits.length >= 1 && words(inc.title).some((w) => hits.includes(w)));
}
function incidentLine(inc: any): string { return inc ? `Heads up: ${inc.message}${inc.eta ? " Expected: " + inc.eta + "." : ""}` : ""; }
function statusWord(s: string) { return ({ new: "received and waiting for the office", acknowledged: "acknowledged by the office", in_progress: "in progress", escalated: "escalated to on-call", resolved: "resolved", closed: "closed", cancelled: "cancelled" } as any)[s] || s; }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const ackToken = url.searchParams.get("ack");
  if (req.method === "GET" && ackToken) {
    const { data: sr } = await supabase.from("service_requests").select("id, short_ref, acknowledged_at, status").eq("ack_token", ackToken).maybeSingle();
    if (!sr) return html(`<body style="font-family:system-ui;padding:40px;text-align:center"><h2>Link not found</h2><p>This confirmation link is no longer valid.</p></body>`, 404);
    if (!sr.acknowledged_at) await supabase.from("service_requests").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: "on-call", status: sr.status === "resolved" || sr.status === "closed" ? sr.status : "in_progress" }).eq("id", sr.id);
    return html(`<body style="font-family:system-ui;padding:40px;text-align:center;max-width:480px;margin:0 auto"><div style="width:64px;height:64px;border-radius:50%;background:#0f7b3b;color:#fff;font-size:34px;line-height:64px;margin:0 auto 18px">&#10003;</div><h2 style="margin:0 0 8px">Got it — thank you</h2><p style="color:#555">Emergency ${esc(sr.short_ref)} is marked as being handled. Donna will not escalate it further.</p></body>`);
  }

  if (req.method !== "POST") return json({ result: "" }, 405);
  let raw = ""; try { raw = await req.text(); } catch { raw = ""; }
  let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return json({ result: "Sorry, I had trouble with that." }); }

  const { account_id, channel } = await resolveAccount(req, raw, body);
  if (!account_id) return json({ result: "I'm sorry, I couldn't verify the account for this request.", ok: false }, 200);

  const call = body?.call ?? {};
  const args = body?.args ?? body ?? {};
  const action = pick(args.action ?? body.action ?? "identify").toLowerCase();
  const phone = normPhone(args.phone ?? args.callback_number ?? call.from_number ?? "");
  const email = pick(args.email).toLowerCase();
  const callerName = pick(args.name ?? args.caller_name);
  const propHint = pick(args.property ?? args.community ?? args.building ?? args.property_name ?? args.address);
  const propId = pick(args.property_id);
  const unitArg = pick(args.unit ?? args.unit_number ?? args.apartment ?? args.suite);
  const account = await getAccount(account_id);
  (account as any).id = account_id;
  const settings: any = account.settings || {};
  const tz = pick(settings.timezone) || "America/Chicago";
  const business = account.name || "the property office";
  const props = await listProperties(account_id);
  const ctx = await callerContext(account_id, props, phone, email, propHint, propId);
  const property = ctx.property;
  const unit = unitArg || ctx.unit || "";
  const ptype = property?.property_type || (props[0]?.property_type) || "residential";
  const terms = typeTerms(ptype);

  if (action === "identify") {
    let coi: any = null;
    if (property && property.require_tenant_insurance && ctx.contact) { const { data: ins } = await supabase.from("tenant_insurance").select("status, expiration_date").eq("account_id", account_id).eq("property_id", property.id).order("updated_at", { ascending: false }).limit(1); if (ins && ins[0]) coi = ins[0]; }
    const child = routeChild(ctx.links, property);
    const incident = await activeIncident(account_id, property);
    const openReqs = ctx.contact ? (await supabase.from("service_requests").select("short_ref, title, status, request_type, created_at, property_id").eq("account_id", account_id).eq("contact_id", ctx.contact.id).not("status", "in", "(resolved,closed,cancelled)").order("created_at", { ascending: false }).limit(5)).data || [] : [];
    const openHere = property ? openReqs.filter((r: any) => r.property_id === property.id).slice(0, 3) : openReqs.slice(0, 3);
    return json({
      ok: true, recognized: !!ctx.contact, name: ctx.contact?.preferred_name || ctx.contact?.name || null, role: ctx.role, authorized: ctx.authorized, company: ctx.company, unit: unit || null,
      matched_property: property ? { id: property.id, name: property.name, type: property.property_type, structure: property.community_structure || null, lease_type: property.lease_type_default || null } : null,
      also_manages_home_here: child ? { id: child.id, name: child.name, type: child.property_type } : null,
      properties: props.map((p) => ({ id: p.id, name: p.name, type: p.property_type })),
      require_insurance: !!property?.require_tenant_insurance, coi, terms,
      open_requests: openHere.map((r: any) => ({ ref: r.short_ref, title: r.title, status: statusWord(r.status) })),
      incident: incident ? { title: incident.title, message: incident.message, eta: incident.eta } : null,
      playbook: playbookFor(property, ctx, business) + (incident ? ` ACTIVE NOTICE at this property: "${incident.title}" — ${incident.message}${incident.eta ? " Expected: " + incident.eta + "." : ""} If the caller is calling about this, tell them right away, say there is no need to report it again, and only log something if they describe NEW damage or a different problem.` : ""),
      result: (ctx.contact ? `Caller recognized as ${ctx.contact.preferred_name || ctx.contact.name || "a known contact"}${property ? ` (${ctx.role || "role not on file"} at ${property.name})` : ""}.` : (props.length > 1 ? "Caller not recognized. Ask which property or community this is about, and who they are there." : "Caller not recognized.")) + (openHere.length ? ` They have ${openHere.length} open request${openHere.length > 1 ? "s" : ""} at this property: ${openHere.map((r: any) => r.short_ref).join(", ")}.` : "") + (incident ? ` ACTIVE NOTICE: ${incident.title}.` : ""),
    });
  }

  if (action === "status") {
    const refRaw = pick(args.reference ?? args.short_ref ?? args.ref).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const ref = refRaw ? "SR-" + refRaw.replace(/^SR/, "") : "";
    let q = supabase.from("service_requests").select("short_ref, title, request_type, status, created_at, due_at, assigned_to, dispatched_at, accepted_at, completed_at, acknowledged_at, dispatch_state, escalation_state, resolved_note, property_id, details, properties!service_requests_property_id_fkey(name)").eq("account_id", account_id);
    if (ref) q = q.eq("short_ref", ref);
    else if (ctx.contact) { q = q.eq("contact_id", ctx.contact.id).not("status", "in", "(closed,cancelled)"); if (property) q = q.eq("property_id", property.id); }
    else return json({ ok: false, result: "I don't have a request on file under this number. Do you have the reference number, or the phone number it was reported from?" });
    const { data: rows, error: qerr } = await q.order("created_at", { ascending: false }).limit(3);
    if (qerr) console.error("status query failed", qerr.message);
    if (!rows || !rows.length) return json({ ok: true, found: 0, result: ref ? `I don't see a request ${ref}. Could you double-check the reference?` : "I don't see any requests under your number yet. Would you like me to log one?" });
    const lines = rows.map((r: any) => {
      let s = `${r.short_ref} (${r.title || r.request_type}${r.properties ? " at " + r.properties.name : ""}) is ${statusWord(r.status)}`;
      const es = r.escalation_state || {}; const lastN = Array.isArray(es.notified) && es.notified.length ? es.notified[es.notified.length - 1] : null;
      const d = r.details || {};
      if (r.dispatched_at) { const who = (r.dispatch_state && r.dispatch_state.contractor) || r.assigned_to; s += `. ${who ? who + " was dispatched" : "A contractor was dispatched"} on ${fmtDate(r.dispatched_at, tz)}`; if (r.accepted_at) s += ` and has accepted the job`; if (r.completed_at) s += ` and marked it complete on ${fmtDate(r.completed_at, tz)}`; if (d.access_window && d.access_window.start) s += `. The visit is set for ${fmtWhen(d.access_window.start, tz)}`; else if (d.access_coordination === "offered") s += `. You've been sent times to choose from for the visit`; }
      else if (r.status === "escalated" && lastN) { s += `. ${lastN.name || "The on-call contact"} was alerted at ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(lastN.at || r.created_at))}`; s += r.acknowledged_at ? ` and has confirmed they're handling it` : ` and hasn't confirmed yet — if there's no confirmation shortly, it escalates to the next contact automatically`; }
      else if (d.approval === "pending") s += `. It's waiting on ${r.assigned_to || "owner approval"}`;
      else if (r.assigned_to) s += `, assigned to ${r.assigned_to}`;
      if (r.due_at && !["resolved","closed"].includes(r.status)) s += `. It's due by ${fmtDate(r.due_at, tz)}`;
      if (r.resolved_note) s += `. Note: ${r.resolved_note}`;
      return s + ".";
    });
    return json({ ok: true, found: rows.length, requests: rows, result: lines.join(" ") });
  }

  if (action === "log" || action === "emergency") {
    const description = pick(args.description ?? args.message ?? args.details ?? args.note ?? args.issue);
    const title = pick(args.title ?? args.subject) || (description ? description.slice(0, 60) : "Request");
    let reqType = pick(args.request_type ?? args.type).toLowerCase();
    const validTypes = ["maintenance","emergency","arc","violation","amenity","coi","leasing","general","access","account","records"];
    if (!validTypes.includes(reqType)) reqType = "general";
    const isEmergency = action === "emergency" || truthy(args.is_emergency ?? args.emergency ?? args.urgent) || reqType === "emergency";
    let priority = pick(args.priority).toLowerCase();
    if (isEmergency) priority = "emergency"; else if (!["routine","urgent"].includes(priority)) priority = "routine";
    if (isEmergency && reqType === "general") reqType = "emergency";
    if (!property) return json({ ok: false, result: props.length > 1 ? "Which property or community is this for?" : "I couldn't tell which property this is for." });

    const scope = (reqType === "maintenance" || reqType === "emergency" || reqType === "general") ? inferScope(property.property_type, property.community_structure, `${title} ${description}`, pick(args.location_scope ?? args.scope)) : null;
    let target = property;
    let routedNote = "";
    if (scope && property.property_type === "hoa" && (scope === "in_unit")) {
      const child = routeChild(ctx.links, property);
      if (child) { target = props.find((p) => p.id === child.id) || child; routedNote = `Routed to the managed home ${child.name} (inside ${property.name}).`; }
    }
    const resp = scope ? responsibility(target, scope) : { ours: true, why: "", guidance: "" };
    const contact = await ensureContact(account_id, phone, email, callerName);
    let pcId: string | null = null;
    if (contact && target) pcId = await ensurePropertyContact(account_id, target.id, contact.id, pick(args.role) || (target.property_type === "hoa" ? "owner" : "tenant"), unit, callerName, phone, email);

    const inc = await activeIncident(account_id, target);
    if (inc && incidentMatches(inc, `${title} ${description}`) && !/damage|flood(ing)? (in|into) my|water (in|inside) my|ceiling|injur|hurt|smoke|fire|gas/i.test(description)) {
      await supabase.from("service_requests").insert({ account_id, property_id: target.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "general", category: pick(args.category) || null, priority: "routine", status: "closed", title: `Re: ${inc.title} — ${title}`.slice(0, 120), description: description || null, unit: unit || null, reported_channel: channel === "manual" ? "manual" : channel, photos: [], short_ref: shortRef(), scope, details: { incident_id: inc.id, covered_by_incident: true, caller_role: ctx.role }, resolved_note: "Covered by the active notice", resolved_at: new Date().toISOString() });
      return json({ ok: true, covered_by_incident: true, result: `${incidentLine(inc)} We already have it and the team is on it — there's no need to report it again; I've noted that you called so you get the update. If you see anything new, like water inside your ${target.property_type === "commercial" ? "suite" : "home"}, tell me and I'll log that separately.` });
    }
    if (scope && !resp.ours) {
      const emType = isEmergency ? detectEmergencyType(`${title} ${description}`, pick(args.emergency_type)) : null;
      const safety = emType ? safetySteps(emType) : "";
      const row: any = { account_id, property_id: target.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "general", category: pick(args.category) || null, priority: "routine", status: "closed", title: `Not ours — ${title}`, description: description || null, unit: unit || null, reported_channel: channel === "manual" ? "manual" : channel, photos: [], short_ref: shortRef(), scope, details: { deflected: true, reason: resp.why, emergency_type: emType }, resolved_note: `Owner/tenant responsibility (${resp.why}). Guidance given.`, resolved_at: new Date().toISOString() };
      await supabase.from("service_requests").insert(row);
      const vendorLine = target.property_type === "hoa" ? " I've made a note of it so the office knows; you'd reach a plumber or handyman directly." : " I can share the office's approved vendor list if you'd like.";
      return json({ ok: true, ours: false, scope, result: `${safety ? safety + " " : ""}${resp.guidance}${vendorLine}` });
    }

    const row: any = {
      account_id, property_id: target.id, property_contact_id: pcId, contact_id: contact?.id ?? null,
      request_type: reqType, category: pick(args.category) || null, priority, status: isEmergency ? "escalated" : "new",
      title, description: description || null, unit: unit || null,
      access_instructions: pick(args.access_instructions ?? args.access) || null,
      permission_to_enter: typeof args.permission_to_enter === "boolean" ? args.permission_to_enter : (truthy(args.permission_to_enter) || null),
      reported_channel: channel === "manual" ? "manual" : channel, photos: [],
      short_ref: shortRef(), ack_token: isEmergency ? tok() : null,
      escalated_at: isEmergency ? new Date().toISOString() : null,
      scope, routed_property_id: target.id !== property.id ? property.id : null,
      details: { caller_role: ctx.role, authorized: ctx.authorized, company: ctx.company, routed: routedNote || undefined, lease_note: resp.why || undefined },
    };
    const { data: sr, error } = await supabase.from("service_requests").insert(row).select("*").maybeSingle();
    if (error || !sr) { console.error("sr insert failed", error?.message); return json({ ok: false, result: "I'm sorry, I had trouble logging that. Let me take it down again." }); }

    if (isEmergency) {
      const emType = detectEmergencyType(`${title} ${description}`, pick(args.emergency_type));
      const callback = phone || normPhone(call.from_number);
      const ladder = await pickEscalationContacts(account_id, target.id, emType);
      let notified: string[] = []; let primaryName = "";
      if (ladder.length) {
        const primary = ladder[0]; primaryName = primary.name;
        notified = await notifyOnCall({ account, property: target, recipient: primary, caller: contact, sr: { ...sr, unit: row.unit, description: row.description }, emType, callback, business });
        await supabase.from("service_requests").update({ assigned_to: primary.name, escalation_state: { tier: 0, emergency_type: emType, last_notified_at: new Date().toISOString(), notified: [{ name: primary.name, email: primary.email, phone: primary.phone, at: new Date().toISOString(), via: notified }] } }).eq("id", sr.id);
      } else {
        await notifyOnCall({ account, property: target, recipient: { email: pick(settings.alert_email), phone: null }, caller: contact, sr: { ...sr, unit: row.unit, description: row.description }, emType, callback, business });
        await supabase.from("service_requests").update({ escalation_state: { tier: 0, emergency_type: emType, last_notified_at: new Date().toISOString(), notified: [], no_oncall: true } }).eq("id", sr.id);
      }
      const safety = safetySteps(emType);
      return json({ ok: true, short_ref: sr.short_ref, emergency: true, notified_via: notified, on_call: primaryName || null, scope, result: `${safety ? safety + " " : ""}I've logged this as an emergency${routedNote ? " for " + target.name : ""} and I'm alerting ${primaryName ? primaryName : "the on-call team"} right now. Your reference is ${sr.short_ref}. Someone will get back to you as soon as possible. Is there anything else I can help with?` });
    }

    let autoDisp: any = null;
    const trade = pick(args.category);
    if (trade && !(target.property_type === "hoa" && target.board_approval_threshold != null && Number(target.board_approval_threshold) <= 0)) {
      const rule = await matchAutoRule(account_id, target.id, trade);
      if (rule?.contractor_id) { const { data: con } = await supabase.from("contractors").select("id, is_active").eq("id", rule.contractor_id).eq("account_id", account_id).maybeSingle(); if (con && con.is_active) autoDisp = await autoDispatch(account_id, sr.id, rule.contractor_id); }
    }
    const win = responseWindow(target.property_type, reqType, priority);
    const dispatchLine = autoDisp?.contractor ? ` I've also dispatched ${autoDisp.contractor} to take care of it.` : "";
    const authLine = (target.property_type === "commercial" && !ctx.authorized && /billable|after.?hours|key|lock|card|access/i.test(`${title} ${description}`)) ? " Since this may be billable, an authorized contact for your company will need to confirm it before work starts." : "";
    return json({ ok: true, short_ref: sr.short_ref, emergency: false, dispatched: autoDisp?.contractor || null, scope, result: `I've logged your ${reqType === "general" ? "request" : reqType.replace(/_/g, " ")}${target ? ` for ${target.name}` : ""}${unit ? `, ${target.property_type === "commercial" ? "suite" : "unit"} ${unit}` : ""}. Your reference number is ${sr.short_ref}, and someone will follow up ${win}.${dispatchLine}${authLine} Is there anything else I can help with?` });
  }

  if (action === "arc") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: "Which community is this for?" });
    if (property.property_type !== "hoa") return json({ ok: false, result: `${property.name} isn't a community association, so there's no architectural review there. Did you mean a different property?` });
    if (ctx.role && ctx.role !== "owner" && ctx.role !== "board") return json({ ok: false, result: "Architectural requests have to come from the owner of record. If you rent, please ask your landlord to submit it — I can note your interest for the office." });
    const contact = await ensureContact(account_id, phone, email, callerName);
    const pcId = contact ? await ensurePropertyContact(account_id, property.id, contact.id, "owner", unit, callerName, phone, email) : null;
    const details = { project: pick(args.project ?? args.description), materials: pick(args.materials), colors: pick(args.colors), contractor: pick(args.contractor), start_date: pick(args.start_date), address: unit || pick(args.address) };
    const due = addBusinessDays(new Date(), 30);
    const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "arc", priority: "routine", status: "new", title: `ARC: ${details.project.slice(0, 50) || "request"}`, description: [details.project, details.materials && ("Materials: " + details.materials), details.colors && ("Colors: " + details.colors), details.contractor && ("Contractor: " + details.contractor), details.start_date && ("Planned start: " + details.start_date)].filter(Boolean).join("\n"), unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details, due_at: due.toISOString(), upload_token: tok() }).select("id, short_ref, upload_token").maybeSingle();
    if (sr && (email || phone)) { fetch(`${SELF}/pm-coordinate`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ action: "arc_upload_link", account_id, service_request_id: sr.id }) }).catch(() => {}); }
    return json({ ok: true, short_ref: sr?.short_ref, result: `I've submitted your architectural request, reference ${sr?.short_ref}. The architectural committee reviews it against the community's guidelines — please don't start work until you have written approval. If it's denied, you'll get the reasons in writing and you may request a hearing with the board within thirty days. ${(email || phone) ? "I'm sending you a link now to attach drawings or photos." : "If you give me an email or cell number I'll send you a link to attach drawings or photos."} Anything else?` });
  }

  if (action === "violation") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: "Which community is this for?" });
    const about = pick(args.about ?? args.subject_of).toLowerCase();
    if (about === "mine" || truthy(args.own_notice)) {
      return json({ ok: true, own: true, result: "Here's how notices work: the letter describes the violation and gives you a reasonable period to correct it. If you fix it within that period, no fine is assessed. You also have the right to request a hearing with the board within thirty days of the notice date. If you'd like, I'll let the manager know you've corrected it or that you want to request a hearing, and someone will confirm in writing." });
    }
    const contact = await ensureContact(account_id, phone, email, callerName);
    const pcId = contact ? await ensurePropertyContact(account_id, property.id, contact.id, ctx.role || "owner", unit, callerName, phone, email) : null;
    const details = { reported_address: pick(args.reported_address ?? args.address_reported ?? args.location), issue: pick(args.issue ?? args.description), when: pick(args.when), anonymous: truthy(args.anonymous) };
    const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "violation", priority: "routine", status: "new", title: `Violation report: ${details.issue.slice(0, 50) || "report"}`, description: `${details.issue}${details.reported_address ? "\nAt: " + details.reported_address : ""}${details.when ? "\nWhen: " + details.when : ""}`, unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details }).select("short_ref").maybeSingle();
    return json({ ok: true, short_ref: sr?.short_ref, result: `Thank you — I've passed that to the community manager, reference ${sr?.short_ref}. The manager will look into it and handle it under the community's rules. For privacy I can't share what happens on another owner's account, but you're welcome to check back if it continues. Anything else?` });
  }

  if (action === "resale_cert") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: "Which community is the property in?" });
    const contact = await ensureContact(account_id, phone, email, callerName);
    const details = { requester_type: pick(args.requester_type) || "title company", requester_company: pick(args.company ?? args.title_company), property_address: pick(args.property_address ?? args.address) || unit, seller: pick(args.seller ?? args.owner), buyer: pick(args.buyer), closing_date: pick(args.closing_date), deliver_to: email || pick(args.deliver_to), is_update: truthy(args.update ?? args.is_update), lender_questionnaire: truthy(args.questionnaire) };
    const days = details.is_update ? 7 : 10;
    const due = addBusinessDays(new Date(), days);
    const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, contact_id: contact?.id ?? null, request_type: "resale_cert", priority: "routine", status: "new", title: `${details.is_update ? "Resale cert update" : (details.lender_questionnaire ? "Lender questionnaire" : "Resale certificate")}: ${details.property_address || property.name}`, description: `Requested by ${details.requester_type}${details.requester_company ? " (" + details.requester_company + ")" : ""}${details.seller ? "\nSeller: " + details.seller : ""}${details.buyer ? "\nBuyer: " + details.buyer : ""}${details.closing_date ? "\nClosing: " + details.closing_date : ""}${details.deliver_to ? "\nDeliver to: " + details.deliver_to : ""}`, unit: details.property_address || null, reported_channel: channel, photos: [], short_ref: shortRef(), details, due_at: due.toISOString() }).select("short_ref").maybeSingle();
    notifyOffice(account, business, `Resale certificate request — ${details.property_address || property.name} [${sr?.short_ref}] due ${fmtDate(due, tz)}`, `Donna took a ${details.is_update ? "resale certificate UPDATE" : (details.lender_questionnaire ? "lender questionnaire" : "resale certificate")} request.\n\nCommunity: ${property.name}\nProperty: ${details.property_address || "(ask)"}\nRequested by: ${details.requester_type}${details.requester_company ? " — " + details.requester_company : ""}${callerName ? " — " + callerName : ""}${phone ? " " + phone : ""}\nDeliver to: ${details.deliver_to || "(ask)"}\nClosing: ${details.closing_date || "(not given)"}\n\nStatutory deadline: ${days} business days — ${fmtDate(due, tz)}.\nRef: ${sr?.short_ref}`);
    return json({ ok: true, short_ref: sr?.short_ref, due: due.toISOString(), result: `I've logged the ${details.is_update ? "update" : "resale certificate"} request for ${details.property_address || property.name}, reference ${sr?.short_ref}. The office prepares these in the order received and within the ${days} business days the law allows, so you'll have it by ${fmtDate(due, tz)} at the latest — usually sooner. ${details.deliver_to ? "It'll go to " + details.deliver_to + "." : "What email should it go to?"} The fee is quoted with the order confirmation.` });
  }

  if (action === "hvac_afterhours") {
    if (!property) return json({ ok: false, result: "Which building is this for?" });
    const hv = property.after_hours_hvac || {};
    if (property.property_type !== "commercial" || hv.enabled === false) return json({ ok: false, result: `After-hours HVAC isn't something I can schedule for ${property.name}. I can take a message for the property manager.` });
    const lead = Number(hv.lead_hours) || 48;
    const when = pick(args.start ?? args.start_time ?? args.when); const endT = pick(args.end ?? args.end_time); const endD = parseWhen(endT, tz);
    const startD = when ? parseWhen(when, tz) : null;
    if (startD && !isNaN(startD.getTime()) && startD.getTime() - Date.now() < lead * 3600000) return json({ ok: false, result: `After-hours HVAC needs ${lead} hours' notice so an engineer can be scheduled. The earliest I can request is ${fmtWhen(new Date(Date.now() + lead * 3600000), tz)}. Would a later window work?` });
    const contact = await ensureContact(account_id, phone, email, callerName);
    const pcId = contact ? await ensurePropertyContact(account_id, property.id, contact.id, "tenant", unit, callerName, phone, email) : null;
    const details = { start: when, end: endT, suite: unit, zones: pick(args.zones ?? args.area), company: ctx.company || pick(args.company), authorized: ctx.authorized, rate_note: hv.rate_note || null };
    const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "hvac_afterhours", category: "hvac_afterhours", priority: "routine", status: "new", title: `After-hours HVAC: ${unit ? "suite " + unit : ""}${startD && !isNaN(startD.getTime()) ? (unit ? " · " : "") + new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(startD) + (endD ? "–" + new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(endD) : "") : (when ? " " + when : "")}`.trim(), description: `Requested window: ${when || "(ask)"}${endT ? " to " + endT : ""}${details.zones ? "\nArea: " + details.zones : ""}\nCompany: ${details.company || "(ask)"}\nAuthorized contact: ${ctx.authorized ? "yes" : "NOT confirmed — needs authorized sign-off"}\nBilling: ${hv.rate_note || "per lease"}`, unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details, due_at: startD && !isNaN(startD.getTime()) ? startD.toISOString() : null }).select("short_ref").maybeSingle();
    return json({ ok: true, short_ref: sr?.short_ref, authorized: ctx.authorized, result: `I've put in the after-hours HVAC request${unit ? " for suite " + unit : ""}${startD ? " for " + fmtWhen(startD, tz) + (endD ? " to " + new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(endD) : "") : (when ? " for " + when : "")}, reference ${sr?.short_ref}. It's billed ${hv.rate_note ? hv.rate_note : "at the rate in your lease"}.${ctx.authorized ? "" : " Because it's billable, one of your company's authorized contacts needs to confirm it — the office will reach out to them."} The engineering team will confirm the window. Anything else?` });
  }

  if (action === "access") {
    if (!property) return json({ ok: false, result: props.length > 1 ? "Which property is this for?" : "I couldn't tell which property this is for." });
    const kind = pick(args.kind ?? args.access_type).toLowerCase();
    if (property.property_type === "hoa") {
      const verified = !!(ctx.contact && ctx.role && ["owner","tenant","board"].includes(ctx.role) && ctx.property && ctx.property.id === property.id);
      if (!property.gate_access) return json({ ok: true, result: "I don't have gate or access details on file for this community; the office can help with that during business hours." });
      if (!verified) return json({ ok: true, released: false, result: "For everyone's security I can only share gate and access information with residents on file. If you're a resident, the office can verify you and update your contact — or if you're calling from the number we have on record, I'll recognize you next time." });
      return json({ ok: true, released: true, result: `Here's the access information on file for ${property.name}: ${speakable(property.gate_access)}. Please don't share it outside your household.` });
    }
    const contact = await ensureContact(account_id, phone, email, callerName);
    const pcId = contact ? await ensurePropertyContact(account_id, property.id, contact.id, "tenant", unit, callerName, phone, email) : null;
    const details = { kind: kind || "access", person: pick(args.person ?? args.for_whom), when: pick(args.when), company: ctx.company || pick(args.company), authorized: ctx.authorized };
    const needsAuth = ["card","key","lock","after_hours","after-hours","rekey","deactivate"].some((k) => (kind + " " + pick(args.description)).toLowerCase().includes(k));
    const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, property_contact_id: pcId, contact_id: contact?.id ?? null, request_type: "access", category: kind || null, priority: "routine", status: "new", title: `Access: ${kind || "request"}${details.person ? " for " + details.person : ""}`, description: `${pick(args.description)}${details.person ? "\nFor: " + details.person : ""}${details.when ? "\nWhen: " + details.when : ""}\nCompany: ${details.company || "(ask)"}\nAuthorized contact: ${ctx.authorized ? "yes" : "not confirmed"}`, unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details }).select("short_ref").maybeSingle();
    return json({ ok: true, short_ref: sr?.short_ref, result: `I've logged the access request, reference ${sr?.short_ref}.${(needsAuth && !ctx.authorized) ? " Access cards, keys, and after-hours entry have to be approved by an authorized contact for your company, so the office will confirm with them before issuing anything." : " The office will follow up to arrange it."} Anything else?` });
  }

  if (action === "account") {
    if (!property) return json({ ok: false, result: props.length > 1 ? "Which property is this about?" : "I couldn't tell which property this is about." });
    const topic = pick(args.topic).toLowerCase();
    const isHoa = property.property_type === "hoa";
    const verifiedOwner = isHoa ? (ctx.role === "owner" || ctx.role === "board") : (ctx.role === "tenant" || ctx.role === "owner");
    if (/balance|owe|how much|statement|ledger/.test(topic) && !verifiedOwner) return json({ ok: true, result: `For privacy I can't read out account balances over the phone unless you're the ${isHoa ? "owner of record" : "tenant on the lease"} and we have you on file. The resident portal shows your balance any time, or the office can verify you and send a statement. Would you like me to ask the office to send one?` });
    if (/plan|arrange|installment|behind|late|can'?t pay|hardship/.test(topic)) {
      const contact = await ensureContact(account_id, phone, email, callerName);
      const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, contact_id: contact?.id ?? null, request_type: "account", category: "payment_plan", priority: "routine", status: "new", title: `Payment plan request${unit ? " — " + unit : ""}`, description: pick(args.description) || "Caller asked about a payment plan.", unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details: { topic } }).select("short_ref").maybeSingle();
      return json({ ok: true, short_ref: sr?.short_ref, result: isHoa ? `Payment plans are available for assessments — the association is required to offer an alternative schedule, and setting one up stops things from going further. I've asked the manager to send you the plan options, reference ${sr?.short_ref}. Payments apply to the oldest assessments first.` : `I've asked the office to reach out about payment arrangements, reference ${sr?.short_ref}. Someone will follow up with the options.` });
    }
    return json({ ok: true, result: isHoa ? "Dues questions I can answer: when assessments are due, where to pay, late-fee policy, and payment plans. For your specific balance, the portal or the office can confirm once you're verified. What would you like to know?" : "Rent questions I can answer: when it's due, where and how to pay, and late-fee policy. I don't take card numbers over the phone. What would you like to know?" });
  }

  if (action === "amenity_list" || action === "amenity_reserve") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: "Which community is this for?" });
    const { data: ams } = await supabase.from("amenities").select("*").eq("account_id", account_id).eq("property_id", property.id).eq("is_active", true).order("name");
    const list = ams || [];
    if (action === "amenity_list" || !pick(args.amenity)) {
      if (!list.length) return json({ ok: true, amenities: [], result: `I don't have reservable amenities on file for ${property.name}. The office can tell you what's available.` });
      return json({ ok: true, amenities: list.map((a: any) => ({ id: a.id, name: a.name, reservable: a.reservable, hours: a.hours, capacity: a.capacity, fee: a.fee, deposit: a.deposit, rules: a.rules })), result: `${property.name} has: ${list.map((a: any) => a.name + (a.reservable ? "" : " (not reservable)")).join(", ")}. Which one, and when?` });
    }
    const want = pick(args.amenity).toLowerCase();
    const am = list.find((a: any) => String(a.name).toLowerCase() === want) || list.find((a: any) => String(a.name).toLowerCase().includes(want) || want.includes(String(a.name).toLowerCase()));
    if (!am) return json({ ok: false, result: `I don't see "${pick(args.amenity)}" on the list for ${property.name}. Available: ${list.map((a: any) => a.name).join(", ") || "none on file"}.` });
    if (!am.reservable) return json({ ok: false, result: `${am.name} isn't reservable — it's first come, first served${am.hours ? " during " + am.hours : ""}.` });
    const verified = !!(ctx.contact && ctx.role && ["owner","tenant","board"].includes(ctx.role));
    if (!verified) return json({ ok: false, result: "Reservations are for residents on file. The office can verify you and add you — or I can take your name and number and have the manager confirm the reservation." });
    const s = parseWhen(pick(args.start), tz) || new Date(NaN); const e = parseWhen(pick(args.end), tz) || (isNaN(s.getTime()) ? new Date(NaN) : new Date(s.getTime() + 2 * 3600000));
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return json({ ok: false, result: `What date and time would you like ${am.name}?` });
    const { data: clash } = await supabase.from("amenity_reservations").select("id").eq("amenity_id", am.id).in("status", ["requested","confirmed"]).lt("starts_at", e.toISOString()).gt("ends_at", s.toISOString()).limit(1);
    if (clash && clash.length) return json({ ok: false, result: `${am.name} is already reserved then. Would another time work?` });
    const guests = Number(args.guests) || null;
    if (am.capacity && guests && guests > am.capacity) return json({ ok: false, result: `${am.name} holds up to ${am.capacity}. Could you keep the group to that?` });
    const { data: res } = await supabase.from("amenity_reservations").insert({ account_id, property_id: property.id, amenity_id: am.id, contact_id: ctx.contact?.id || null, resident_name: callerName || ctx.contact?.name || null, unit: unit || null, starts_at: s.toISOString(), ends_at: e.toISOString(), guests, status: "confirmed", notes: pick(args.notes) || null, source: channel }).select("id").maybeSingle();
    return json({ ok: true, reservation_id: res?.id, result: `You're set: ${am.name} on ${fmtWhen(s, tz)} until ${new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(e)}.${am.fee ? " The fee is " + am.fee + "." : ""}${am.deposit ? " A deposit of " + am.deposit + " applies." : ""}${am.rules ? " A reminder of the rules: " + am.rules : ""} The office will send a confirmation.` });
  }

  if (action === "upcoming") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: props.length > 1 ? "Which property or community is this about?" : "I couldn't tell which property this is about." });
    const nowIso = new Date().toISOString();
    const { data: mtgs } = await supabase.from("pm_meetings").select("id, title, kind, starts_at, location, virtual_url, agenda, quorum_required").eq("property_id", property.id).neq("status", "cancelled").gte("starts_at", nowIso).order("starts_at").limit(3);
    const { data: comp } = await supabase.from("pm_compliance_items").select("title, kind, due_date, vendor_name, access_needed").eq("property_id", property.id).neq("status", "done").gte("due_date", nowIso.slice(0, 10)).order("due_date").limit(4);
    const b = property.board || {};
    const parts: string[] = [];
    for (const m of (mtgs || [])) parts.push(`${m.title} is ${fmtWhen(m.starts_at, tz)}${m.location ? " at " + m.location : (m.virtual_url ? ", held online" : "")}${m.agenda ? ". On the agenda: " + String(m.agenda).slice(0, 140) : ""}.`);
    if (!(mtgs || []).length && b.meeting_schedule) parts.push(`The board normally meets ${b.meeting_schedule}; nothing specific is on the calendar yet.`);
    const access = (comp || []).filter((c: any) => c.access_needed);
    if (access.length) parts.push(`Coming up that needs access: ${access.map((c: any) => `${c.title} around ${fmtDate(c.due_date + "T12:00:00Z", tz)}`).join("; ")}. The office will coordinate a time with you.`);
    return json({ ok: true, meetings: mtgs || [], compliance: comp || [], result: parts.length ? parts.join(" ") : `Nothing is scheduled at ${property.name} right now${b.meeting_schedule ? "; the board normally meets " + b.meeting_schedule : ""}.` });
  }

  if (action === "rsvp") {
    const property = communityOf(props, ctx.property);
    if (!property) return json({ ok: false, result: "Which community is the meeting for?" });
    const verified = !!(ctx.contact && ctx.role && ["owner", "board", "tenant"].includes(ctx.role));
    if (!verified) return json({ ok: false, result: "I can take RSVPs from owners on file. The office can verify you and add you, or I can take your name and address and have the manager record it." });
    const hint = pick(args.meeting).toLowerCase();
    const { data: mtgs } = await supabase.from("pm_meetings").select("*").eq("property_id", property.id).neq("status", "cancelled").gte("starts_at", new Date().toISOString()).order("starts_at").limit(5);
    const list = mtgs || [];
    const m = (hint ? list.find((x: any) => String(x.title).toLowerCase().includes(hint) || String(x.kind).toLowerCase().includes(hint)) : null) || list[0];
    if (!m) return json({ ok: false, result: `I don't see an upcoming meeting on the calendar for ${property.name}. The office can confirm the date.` });
    const attending = args.attending === false || /\b(no|not|can'?t|cannot|won'?t)\b/i.test(pick(args.attending)) ? false : true;
    const proxy = truthy(args.proxy) || !!pick(args.proxy_holder);
    const row = { account_id, meeting_id: m.id, contact_id: ctx.contact?.id || null, name: callerName || ctx.contact?.name || null, unit: unit || null, attending: attending && !proxy, proxy, proxy_holder: pick(args.proxy_holder) || null, source: channel };
    const { data: existing } = await supabase.from("pm_meeting_rsvps").select("id").eq("meeting_id", m.id).eq("contact_id", ctx.contact.id).maybeSingle();
    if (existing) await supabase.from("pm_meeting_rsvps").update(row).eq("id", existing.id); else await supabase.from("pm_meeting_rsvps").insert(row);
    const { data: all } = await supabase.from("pm_meeting_rsvps").select("attending, proxy").eq("meeting_id", m.id);
    const att = (all || []).filter((x: any) => x.attending && !x.proxy).length, prox = (all || []).filter((x: any) => x.proxy).length;
    const quorum = m.quorum_required ? ` That makes ${att + prox} of the ${m.quorum_required} needed for quorum${att + prox >= m.quorum_required ? " — quorum is met" : ""}.` : "";
    const what = proxy ? `I've recorded that you're sending a proxy${row.proxy_holder ? " carried by " + row.proxy_holder : ""}` : attending ? "You're on the list as attending" : "I've noted that you can't attend";
    return json({ ok: true, meeting: m.title, attending: row.attending, proxy, counts: { attending: att, proxies: prox }, result: `${what} for the ${m.title} ${fmtWhen(m.starts_at, tz)}${m.location ? " at " + m.location : ""}.${quorum}${!attending && !proxy && property.property_type === "hoa" ? " If you'd like your vote counted, you can name someone to carry your proxy — just let me know." : ""}` });
  }

  if (action === "insurance") {
    if (!property) return json({ ok: false, result: props.length > 1 ? "Which property is this about?" : "I couldn't tell which property this is about." });
    if (property.property_type === "hoa") {
      const ai = property.association_insurance || {};
      const attached = property.community_structure === "attached" || property.community_structure === "mixed";
      const who = pick(args.requester_type).toLowerCase();
      if (/title|lender|mortgage|escrow|agent|insurance agent|evidence|certificate|dec/.test(who + " " + pick(args.topic).toLowerCase())) {
        const contact = await ensureContact(account_id, phone, email, callerName);
        const { data: sr } = await supabase.from("service_requests").insert({ account_id, property_id: property.id, contact_id: contact?.id ?? null, request_type: "records", category: "evidence_of_insurance", priority: "routine", status: "new", title: `Evidence of insurance — ${unit || property.name}`, description: `Requested by ${who || "caller"}${callerName ? " " + callerName : ""}${email ? " <" + email + ">" : ""}${phone ? " " + phone : ""}\nFor: ${unit || "(ask address)"}${ai.certificate_url ? "\nCertificate link on file: " + ai.certificate_url : "\nNo certificate link on file — agent: " + (ai.agent || "(none)")}`, unit: unit || null, reported_channel: channel, photos: [], short_ref: shortRef(), details: { requester: who, deliver_to: email || null } }).select("short_ref").maybeSingle();
        return json({ ok: true, short_ref: sr?.short_ref, result: `I've logged your request for the association's evidence of insurance${unit ? " for " + unit : ""}, reference ${sr?.short_ref}.${ai.carrier ? " The master policy is with " + ai.carrier + (ai.expiration_date ? ", current through " + ai.expiration_date : "") + "." : ""}${ai.agent ? " The agent of record is " + ai.agent + "." : ""} The office will send the certificate${email ? " to " + email : ""}.` });
      }
      const covers = ai.covers ? ai.covers : (attached ? "the common areas and amenities, and the building exteriors, roofs, and foundations; owners insure their interiors, fixtures, and belongings with an HO-6 policy" : "the common areas and amenities only — the pool, clubhouse, entry, and common grounds; each owner insures their own home");
      return json({ ok: true, result: `The association's master policy covers ${covers}.${ai.carrier ? " It's carried by " + ai.carrier + "." : ""} Homeowners aren't asked to file insurance with the association. If you're asking whether a specific repair is the association's or yours, tell me what happened and I'll tell you how it's treated here.` });
    }
    const { data: ins } = await supabase.from("tenant_insurance").select("status, expiration_date, carrier").eq("account_id", account_id).eq("property_id", property.id).order("updated_at", { ascending: false }).limit(1);
    const rec = ins && ins[0];
    if (!property.require_tenant_insurance) return json({ ok: true, required: false, result: `${property.name} doesn't require ${property.property_type === "commercial" ? "a certificate of insurance" : "renters insurance"} on file.` });
    if (!rec || rec.status === "none") return json({ ok: true, required: true, status: "none", result: `We don't have your ${property.property_type === "commercial" ? "certificate of insurance" : "renters insurance"} on file yet. I can text or email you a secure link to upload it — would that help?` });
    return json({ ok: true, required: true, status: rec.status, result: rec.status === "verified" ? `Your insurance is verified${rec.expiration_date ? " and expires " + rec.expiration_date : ""}.` : rec.status === "expired" ? `Our records show your insurance has expired. I can send you a link to upload a current certificate.` : `We've received your certificate and it's under review.` });
  }

  if (action === "coi_status") {
    if (!property) return json({ ok: false, result: "I couldn't tell which property this is for — which community or building is it?" });
    if (property.property_type === "hoa") return json({ ok: true, required: false, result: `${property.name} is a community association — homeowners aren't asked to file insurance with it. If you need the association's own policy information, I can help with that.` });
    if (!property.require_tenant_insurance) return json({ ok: true, required: false, result: `${property.name} doesn't require tenant insurance on file.` });
    let pcId: string | null = null;
    if (ctx.contact) { const { data: pcr } = await supabase.from("property_contacts").select("id").eq("account_id", account_id).eq("property_id", property.id).eq("contact_id", ctx.contact.id).limit(1); pcId = pcr?.[0]?.id ?? null; }
    let q = supabase.from("tenant_insurance").select("status, expiration_date, carrier").eq("account_id", account_id).eq("property_id", property.id);
    if (pcId) q = q.eq("property_contact_id", pcId);
    const { data: ins } = await q.order("updated_at", { ascending: false }).limit(1);
    const rec = ins && ins[0];
    if (!rec || rec.status === "none") return json({ ok: true, required: true, status: "none", result: `We don't have a certificate of insurance on file yet. I can text or email you a secure link to upload it — would that help?` });
    const exp = rec.expiration_date ? ` It's on file and expires ${rec.expiration_date}.` : " It's on file.";
    return json({ ok: true, required: true, status: rec.status, result: rec.status === "verified" ? `Your insurance is verified.${exp}` : rec.status === "expired" ? `Our records show your insurance has expired. I can send you a link to upload a current certificate.` : `We've received your certificate and it's under review.` });
  }

  if (action === "coi_send") {
    if (!property) return json({ ok: false, result: "Which property is this for?" });
    if (property.property_type === "hoa") return json({ ok: false, result: "Communities don't collect homeowner insurance, so there's nothing to upload here." });
    const contact = await ensureContact(account_id, phone, email, callerName);
    let pcId: string | null = null;
    if (contact) pcId = await ensurePropertyContact(account_id, property.id, contact.id, "tenant", unit, callerName, phone, email);
    let insId: string | null = null, token = "";
    const { data: existing } = await supabase.from("tenant_insurance").select("id, token").eq("account_id", account_id).eq("property_id", property.id).eq("property_contact_id", pcId || "00000000-0000-0000-0000-000000000000").limit(1);
    if (existing && existing[0]) { insId = existing[0].id; token = existing[0].token || tok(); await supabase.from("tenant_insurance").update({ token, reminded_at: new Date().toISOString() }).eq("id", insId); }
    else { token = tok(); const { data: ins } = await supabase.from("tenant_insurance").insert({ account_id, property_id: property.id, property_contact_id: pcId, unit: unit || null, tenant_name: callerName || null, status: "none", token, reminded_at: new Date().toISOString() }).select("id").maybeSingle(); insId = ins?.id ?? null; }
    const link = `${PUBLIC_BASE}/coi/${token}`;
    const from = pick(settings.email_reply_from) || `${business} <no-reply@client.sidekicklogistics.com>`;
    const what = property.property_type === "commercial" ? "certificate of insurance" : "renters insurance";
    const sent: string[] = [];
    if (email) { const ok = await resendEmail(from, email, `Please upload your ${what} — ${business}`, `Hi${callerName ? " " + callerName : ""},\n\n${business} needs a current ${what} on file for ${property.name}${unit ? ", " + (property.property_type === "commercial" ? "suite " : "unit ") + unit : ""}. It takes a minute:\n\n${link}\n\nThank you.`, `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px"><p>Hi${callerName ? " " + esc(callerName) : ""},</p><p>${esc(business)} needs a current ${what} on file for <b>${esc(property.name)}</b>${unit ? ", " + (property.property_type === "commercial" ? "suite " : "unit ") + esc(unit) : ""}.</p><p><a href="${link}" style="background:#0f2740;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Upload your certificate</a></p><p style="color:#777;font-size:13px">${esc(link)}</p></div>`); if (ok) sent.push("email"); }
    if (phone) { const ok = await sendSms(account_id, phone, `${business}: please upload your ${what} for ${property.name}${unit ? " " + unit : ""}: ${link}`); if (ok) sent.push("text"); }
    return json({ ok: true, link, sent, result: sent.length ? `I've sent a secure upload link by ${sent.join(" and ")}.` : `Here is the secure upload link: ${link}` });
  }

  return json({ ok: false, result: "I'm not sure what you'd like me to do with that." });
});
