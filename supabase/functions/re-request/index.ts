import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna real estate — phone tools (Retell custom functions) v1.
// Routed by `tool` (or args.tool): listing_lookup | re_lead | book_showing | send_application | send_iabs
// Donna never gives legal advice, never quotes commission, never steers by neighborhood makeup (Fair Housing), and never
// reads lockbox codes or tenant details to callers. Showings are booked through the same booking RPC as every other
// Donna appointment; the showing agreement (the agent's own document) is texted through re-sign.
// v2: leads with no listing follow settings.real_estate.unassigned_leads (broker | round_robin | <agent user id>).

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
async function retellSigValid(rawBody: string, sigHeader: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sigHeader) return false;
  const m = String(sigHeader).match(/v=(\d+),d=(.*)/); if (!m) return false; const ts = m[1];
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  try { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody + ts)); const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join(""); const provided = (m[2] || "").trim().toLowerCase(); if (expected.length !== provided.length) return false; let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i); return diff === 0; } catch { return false; }
}
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const say = (result: string, extra: Record<string, unknown> = {}) => json({ result, ...extra });
const now = () => new Date().toISOString();
const normPhone = (p: string) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d.startsWith("1")) return "+" + d; return String(p || "").trim(); };
const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : null; };
const cents = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.round(n * 100); };
const truthy = (v: unknown) => v === true || ["true", "yes", "1", "y"].includes(String(v ?? "").trim().toLowerCase());
const money0 = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const spokenNum = (n: number) => Number.isInteger(n) ? String(n) : String(n).replace(".5", " and a half");
// Addresses the way a person says them, for anything Donna SPEAKS (texts keep the written form): "3907 Belle Maison Dr"
// -> "3907 Belle Maison Drive", "N" -> "North", "#204" -> "unit 204". Otherwise the voice reads "Dr" as "Doctor".
const SUFFIX: Record<string, string> = { dr: "Drive", st: "Street", ave: "Avenue", av: "Avenue", blvd: "Boulevard", rd: "Road", ln: "Lane", ct: "Court", cir: "Circle", pl: "Place", pkwy: "Parkway", hwy: "Highway", trl: "Trail", ter: "Terrace", terr: "Terrace", way: "Way", loop: "Loop", xing: "Crossing", bnd: "Bend", cv: "Cove", pt: "Point", sq: "Square", holw: "Hollow", rdg: "Ridge", mdw: "Meadow", mdws: "Meadows", hts: "Heights", vly: "Valley", vw: "View", crk: "Creek", frk: "Fork", expy: "Expressway", fwy: "Freeway", ste: "suite", apt: "apartment", fm: "F M" };
const DIR: Record<string, string> = { n: "North", s: "South", e: "East", w: "West", ne: "Northeast", nw: "Northwest", se: "Southeast", sw: "Southwest" };
function spokenAddr(a: string): string {
  const toks = String(a || "").replace(/,/g, " , ").split(/\s+/).filter(Boolean);
  return toks.map((t, i) => {
    const bare = t.replace(/\.$/, ""); const k = bare.toLowerCase();
    if (/^#\d+/.test(bare)) return "unit " + bare.slice(1);
    const next = (toks[i + 1] || "").replace(/\.$/, ""); const nk = next.toLowerCase();
    const endOfStreet = i === toks.length - 1 || next === "," || /^#/.test(next) || ["ste", "suite", "apt", "unit", "bldg"].includes(nk) || !!DIR[nk];
    if (i > 0 && SUFFIX[k] && (endOfStreet || ["ste", "apt"].includes(k))) return SUFFIX[k];
    if (k === "st" && i > 0 && next && /^[A-Z]/.test(next) && !endOfStreet) return "Saint";
    if (i > 0 && DIR[k] && (i === 1 || i === toks.length - 1 || SUFFIX[nk])) return DIR[k];
    return t;
  }).join(" ").replace(/\s,/g, ",");
}
function describe(l: any, brief = false): string {
  const price = l.price_cents == null ? "" : l.listing_type === "for_rent" ? `${money0(l.price_cents)} a month` : l.listing_type === "for_lease" ? (l.price_period === "sqft_year" ? `$${(l.price_cents / 100).toFixed(2)} per square foot per year` : `${money0(l.price_cents)} a month`) : money0(l.price_cents);
  const where = `${spokenAddr(l.address)}${l.city ? " in " + l.city : ""}`;
  if (l.property_type === "land" || l.property_type === "farm_ranch") return `${where}: ${l.acres ? spokenNum(Number(l.acres)) + " acres" : l.lot_sqft ? Number(l.lot_sqft).toLocaleString() + " square foot lot" : "land"}${price ? ", " + price : ""}${brief ? "" : l.description ? ". " + l.description : ""}`;
  if (l.property_type === "commercial") return `${where}: ${l.sqft ? Number(l.sqft).toLocaleString() + " square feet of " : ""}commercial space${price ? ", " + price : ""}${brief ? "" : l.description ? ". " + l.description : ""}`;
  const rooms = [l.beds != null ? `${spokenNum(Number(l.beds))} bedroom${Number(l.beds) === 1 ? "" : "s"}${l.office ? " plus an office" : ""}` : "", l.baths != null ? `${spokenNum(Number(l.baths))}${l.half_baths ? " and a half" : ""} bath${Number(l.baths) === 1 && !l.half_baths ? "" : "s"}` : "", l.sqft ? `about ${Number(l.sqft).toLocaleString()} square feet` : ""].filter(Boolean).join(", ");
  const extras = brief ? "" : [l.year_built ? `built in ${l.year_built}` : "", l.garage ? `${l.garage}-car garage` : "", l.pool ? "pool" : "", l.listing_type === "for_rent" && l.pets ? ({ no: "no pets", cats: "cats okay", dogs: "dogs okay", cats_dogs: "cats and dogs okay", case_by_case: "pets case by case" } as any)[l.pets] || "" : "", l.listing_type === "for_rent" && l.available_on ? `available ${new Date(l.available_on + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : ""].filter(Boolean).join(", ");
  return `${where}: ${rooms}${price ? ", " + price : ""}${extras ? ". " + extras.charAt(0).toUpperCase() + extras.slice(1) : ""}${brief || !l.description ? "" : ". " + String(l.description).replace(/\.\s*$/, "")}`;
}
async function sendText(accountId: string, to: string, body: string): Promise<boolean> { try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; } }
async function callFn(fn: string, body: any): Promise<any> { try { const r = await fetch(`${SELF}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(body) }); return await r.json().catch(() => ({})); } catch { return {}; } }
async function agentPhones(accountId: string, agentUserId: string | null): Promise<string[]> {
  const out = new Set<string>();
  if (agentUserId) { const { data } = await supabase.from("users").select("phone").eq("id", agentUserId).maybeSingle(); if ((data as any)?.phone) out.add((data as any).phone); }
  if (!out.size) { const { data } = await supabase.from("users").select("phone").eq("account_id", accountId).eq("role", "owner").not("phone", "is", null).limit(1); for (const u of data || []) if ((u as any).phone) out.add((u as any).phone); }
  return [...out];
}
async function findListings(accountId: string, args: any): Promise<any[]> {
  const q = String(args.query || args.address || args.q || "").trim();
  const type = ["for_sale", "for_rent", "for_lease"].includes(args.listing_type) ? args.listing_type : (/rent|lease|rental/i.test(String(args.intent || "")) ? "for_rent" : /buy|sale|purchase/i.test(String(args.intent || "")) ? "for_sale" : null);
  const zip = String(args.zip || "").replace(/\D/g, "").slice(0, 5) || null;
  const find = async (pq: string | null, minBeds: number | null) => { const { data, error } = await supabase.rpc("re_find_listings", { p_account: accountId, p_q: pq, p_type: type, p_zip: zip, p_min_beds: minBeds, p_max_price: cents(args.max_price), p_limit: 20 }); if (error) console.error("re_find_listings", error.message); return (data || []) as any[]; };
  const mb = num(args.min_beds);
  let rows = await find(q || null, mb);
  // A descriptive query ("5 bedroom", "something with a pool") isn't an address: fall back to criteria only.
  let usedQ = q || null;
  if (!rows.length && q && !/\d{3,}/.test(q)) { rows = await find(null, mb); usedQ = null; }
  // "5 bedroom" with nothing exact: a 4-bedroom with an office counts (Donna says so out loud).
  if (!rows.length && mb && mb >= 5) {
    const alt = await find(usedQ, mb - 1);
    rows = alt.filter((r: any) => r.office); for (const r of rows) r._office_as_bed = true;
  }
  // Street-number match ("3903") beats everything when the caller gives one.
  const sn = q.match(/\b(\d{3,6})\b/); if (sn && rows.length > 1) { const hit = rows.filter((r: any) => String(r.address).startsWith(sn[1] + " ")); if (hit.length) rows = hit; }
  return rows;
}
async function upsertContact(accountId: string, name: string, phone: string, email: string | null): Promise<string | null> {
  try {
    if (!phone) return null;
    const { data: c } = await supabase.from("contacts").select("id, name, email").eq("account_id", accountId).eq("phone", phone).maybeSingle();
    if (c) { const patch: any = {}; if (name && (!c.name || /^unknown|caller$/i.test(c.name))) patch.name = name; if (email && !c.email) patch.email = email; if (Object.keys(patch).length) await supabase.from("contacts").update(patch).eq("id", c.id); return c.id; }
    const { data: n } = await supabase.from("contacts").insert({ account_id: accountId, name: name || "Caller", phone, email }).select("id").maybeSingle(); return n?.id || null;
  } catch { return null; }
}
// Who gets a lead that isn't tied to a listing. settings.real_estate.unassigned_leads:
//   "broker" (default) -> nobody assigned; the owner's phone gets the hot-lead text
//   "round_robin"      -> the active agent (non-owner) who has waited longest since their last new lead
//   "<user_id>"        -> always that agent (if still active)
async function routeUnassigned(accountId: string, settings: any): Promise<string | null> {
  const rule = String(settings?.real_estate?.unassigned_leads || "broker");
  if (rule === "broker") return null;
  const { data: agents } = await supabase.from("users").select("id, role, created_at").eq("account_id", accountId).eq("is_active", true).neq("role", "owner").order("created_at");
  const list = (agents || []) as any[];
  if (!list.length) return null;
  if (rule !== "round_robin") return list.some((a) => a.id === rule) ? rule : null;
  const { data: recent } = await supabase.from("re_leads").select("agent_user_id, created_at").eq("account_id", accountId).not("agent_user_id", "is", null).gte("created_at", new Date(Date.now() - 90 * 86400000).toISOString()).order("created_at", { ascending: false });
  const last = new Map<string, string>();
  for (const r of (recent || []) as any[]) if (!last.has(r.agent_user_id)) last.set(r.agent_user_id, r.created_at);
  list.sort((a, b) => (last.get(a.id) || "").localeCompare(last.get(b.id) || "") || String(a.created_at).localeCompare(String(b.created_at)));
  return list[0].id;
}
async function upsertLead(accountId: string, args: any, listing: any | null, fromNumber: string, settings?: any): Promise<any> {
  const phone = normPhone(args.phone || args.callback_number || fromNumber);
  const name = String(args.name || args.caller_name || "").trim();
  const email = String(args.email || "").trim() || null;
  const kind = ["buyer", "seller", "renter", "landlord", "tenant", "other"].includes(args.kind) ? args.kind : (listing?.listing_type === "for_rent" ? "renter" : "buyer");
  const contactId = await upsertContact(accountId, name, phone, email);
  const patch: any = { account_id: accountId, contact_id: contactId, kind, name: name || null, phone: phone || null, email, source: "phone", updated_at: now() };
  if (listing) patch.listing_id = listing.id;
  if (listing?.agent_user_id) patch.agent_user_id = listing.agent_user_id;
  const str = (k: string, max = 240) => { const v = String(args[k] ?? "").trim(); return v ? v.slice(0, max) : undefined; };
  const set = (k: string, v: any) => { if (v !== undefined && v !== null && v !== "") patch[k] = v; };
  set("timeline", str("timeline")); set("price_min_cents", cents(args.price_min ?? args.budget_min)); set("price_max_cents", cents(args.price_max ?? args.budget_max ?? args.budget));
  if (args.areas) set("areas", Array.isArray(args.areas) ? args.areas : String(args.areas).split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  if (args.preapproved !== undefined && args.preapproved !== "") set("preapproved", truthy(args.preapproved)); if (args.has_agent !== undefined && args.has_agent !== "") set("has_agent", truthy(args.has_agent)); if (args.lender_referral !== undefined) set("lender_referral", truthy(args.lender_referral));
  set("property_address", str("property_address")); set("beds_wanted", num(args.beds_wanted ?? args.beds)); set("pets", str("pets", 80)); set("household_size", num(args.household_size));
  if (args.move_in) { const d = new Date(String(args.move_in)); if (!isNaN(d.getTime())) set("move_in", d.toISOString().slice(0, 10)); }
  set("notes", str("notes", 1000)); if (args.hot !== undefined) set("hot", truthy(args.hot));
  // Same phone + kind in the last 30 days → update rather than duplicate.
  let existing: any = null;
  if (phone) { const { data } = await supabase.from("re_leads").select("*").eq("account_id", accountId).eq("phone", phone).eq("kind", kind).gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("created_at", { ascending: false }).limit(1); existing = data?.[0] || null; }
  if (existing) { if (patch.notes && existing.notes && !existing.notes.includes(patch.notes)) patch.notes = (existing.notes + "\n" + patch.notes).slice(0, 2000); delete patch.account_id; if (existing.agent_user_id) delete patch.agent_user_id; const { data } = await supabase.from("re_leads").update(patch).eq("id", existing.id).select("*").maybeSingle(); return data || existing; }
  if (!patch.agent_user_id) { const to = await routeUnassigned(accountId, settings); if (to) patch.agent_user_id = to; }
  const { data, error } = await supabase.from("re_leads").insert(patch).select("*").maybeSingle(); if (error) console.error("re_leads insert", error.message); return data;
}
async function maybeSendIabs(acct: any, lead: any) {
  const s = acct.settings?.real_estate || {}; if (!s.iabs_url || !lead?.phone || lead.iabs_sent_at) return false;
  const r = await callFn("re-sign", { action: "send_iabs", account_id: acct.id, lead_id: lead.id }); return !!r?.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return say("", {});
  let raw = ""; try { raw = await req.text(); } catch { /* */ }
  const sigOk = await retellSigValid(raw, req.headers.get("x-retell-signature"));
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!sigOk && auth !== SERVICE_ROLE && RETELL_SIG_ENFORCE) return json({ error: "unauthorized" }, 401);
  let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return say("Sorry, I had trouble with that. Could you say it again?"); }
  const call = body.call || {}; const args = body.args || body || {};
  const tool = String(body.tool || args.tool || body.name || "").trim();
  const outbound = call.direction === "outbound"; // wizard test call: Donna is FROM
  const toNumber = (outbound ? call.from_number : call.to_number) || body.to_number; const fromNumber = (outbound ? call.to_number : call.from_number) || body.from_number || "";
  let accountId: string | null = body.account_id || null;
  if (!accountId && toNumber) { const { data: asst } = await supabase.from("assistants").select("account_id").eq("twilio_number", toNumber).maybeSingle(); accountId = asst?.account_id || null; }
  if (!accountId) return say("Sorry, I'm having trouble looking that up right now. Let me take your name and number and have the agent call you.");
  const { data: acct } = await supabase.from("accounts").select("id, name, settings, industry").eq("id", accountId).maybeSingle();
  if (!acct) return say("Sorry, I'm having trouble looking that up right now.");
  const s = acct.settings?.real_estate || {}; const tz = acct.settings?.timezone || "America/Chicago";
  const agentName = s.agent_name || acct.name;

  // ---------- listing_lookup ----------
  if (tool === "listing_lookup") {
    const rows = await findListings(acct.id, args);
    if (!rows.length) { const { count } = await supabase.from("re_listings").select("id", { count: "exact", head: true }).eq("account_id", acct.id).in("status", ["coming_soon", "active", "pending"]); return say(count ? `I don't see one matching that. Could you give me the street address, or tell me what you're looking for — how many bedrooms, the area, and your budget — and I'll check what we have?` : `We don't have any listings on the books right now, but ${agentName} can help you find one. Can I take your name and number so they can reach you?`, { found: 0 }); }
    if (rows.length === 1) { const l = rows[0]; const officeNote = l._office_as_bed ? " It has four true bedrooms plus a separate office that many people use as a fifth bedroom." : ""; const showing = l.occupied ? " It's currently occupied, so showings need a little notice." : ""; return say(`${describe(l)}.${officeNote}${l.status === "pending" ? " It's pending right now, but I can note your interest in case that changes." : ""}${showing} Would you like to set up a showing?`, { found: 1, listing_id: l.id, address: l.address, listing_type: l.listing_type, status: l.status }); }
    const same = rows.every((r: any) => r.beds === rows[0].beds && r.baths === rows[0].baths && r.price_cents === rows[0].price_cents && r.sqft === rows[0].sqft);
    const list = rows.slice(0, 4).map((r: any) => same ? spokenAddr(r.address) : describe(r, true)).join("; ");
    const officeNote = rows[0]._office_as_bed ? " They have four true bedrooms plus a separate office that many people use as a fifth bedroom." : "";
    return say(same ? `I have ${rows.length} that fit: ${list}${rows.length > 4 ? `, and ${rows.length - 4} more` : ""}. They're all ${describe(rows[0], true).split(": ")[1]}.${officeNote} Which one would you like to hear about or see?` : `Here's what I have: ${list}${rows.length > 4 ? ", and a couple more" : ""}. Which one would you like to hear more about?`, { found: rows.length, listings: rows.map((r: any) => ({ id: r.id, address: r.address, listing_type: r.listing_type })) });
  }

  // ---------- re_lead ----------
  if (tool === "re_lead") {
    let listing: any = null; if (args.listing_id) { const { data } = await supabase.from("re_listings").select("*").eq("id", args.listing_id).eq("account_id", acct.id).maybeSingle(); listing = data; } else if (args.listing_address) { const rows = await findListings(acct.id, { query: args.listing_address }); listing = rows[0] || null; }
    const lead = await upsertLead(acct.id, args, listing, fromNumber, acct.settings);
    if (!lead) return say("Got it. I've noted that for the agent.");
    const iabs = await maybeSendIabs(acct, lead);
    const hot = truthy(args.hot) || (lead.kind === "seller") || (lead.kind === "buyer" && lead.preapproved === true) || (lead.kind === "landlord");
    if (hot && !lead.hot) await supabase.from("re_leads").update({ hot: true }).eq("id", lead.id);
    if (hot) { const who = `${lead.name || "A caller"}${lead.phone ? " (" + lead.phone + ")" : ""}`; const what = lead.kind === "seller" ? `wants to SELL ${lead.property_address || "their home"}${lead.timeline ? ", " + lead.timeline : ""}` : lead.kind === "landlord" ? `wants to rent out ${lead.property_address || "their property"}` : `${lead.preapproved ? "PRE-APPROVED " : ""}buyer${lead.price_max_cents ? " up to " + money0(lead.price_max_cents) : ""}${(lead.areas || []).length ? " in " + lead.areas.join("/") : ""}${lead.timeline ? ", " + lead.timeline : ""}`; for (const p of await agentPhones(acct.id, lead.agent_user_id)) await sendText(acct.id, p, `Hot lead — ${who} ${what}.${lead.notes ? " “" + String(lead.notes).slice(0, 120) + "”" : ""} Call back soon. ${APP}`); }
    let lender = ""; if (lead.kind === "buyer" && lead.preapproved === false && s.lender_partner?.name && (truthy(args.lender_referral) || lead.lender_referral)) { if (lead.phone) await sendText(acct.id, lead.phone, `${acct.name}: as promised, our lender partner ${s.lender_partner.name}${s.lender_partner.phone ? " — " + s.lender_partner.phone : ""}. They can get you pre-approved quickly; mention ${agentName} sent you.`); lender = ` I've texted you ${s.lender_partner.name}'s number.`; }
    return say(`Got it, I've passed that along to ${agentName}.${iabs ? " I also texted you the Texas brokerage services notice — nothing to sign, it's just for your records." : ""}${lender}`, { lead_id: lead.id, hot, iabs_sent: iabs });
  }

  // ---------- book_showing ----------
  if (tool === "book_showing") {
    let listing: any = null; if (args.listing_id) { const { data } = await supabase.from("re_listings").select("*").eq("id", args.listing_id).eq("account_id", acct.id).maybeSingle(); listing = data; } if (!listing) { const rows = await findListings(acct.id, { query: args.address || args.listing_address || args.query }); listing = rows.length === 1 ? rows[0] : null; }
    if (!listing) return say("Which property is that for? Give me the street address and I'll set it up.", { need: "address" });
    const date = String(args.date || "").trim(), time = String(args.time || "").trim(); const callerName = String(args.caller_name || args.name || "").trim(); const phone = normPhone(args.phone || args.callback_number || fromNumber); const email = String(args.email || "").trim() || null;
    if (!date || !time) return say(`Sure. When would you like to see ${spokenAddr(listing.address)}? Give me a day and a time.`, { need: "when" });
    if (!callerName) return say("And who should I put the showing under?", { need: "name" });
    if (listing.status === "pending" || listing.status === "under_contract") return say(`${spokenAddr(listing.address)} is ${listing.status === "pending" ? "pending" : "under contract"} right now, so I can't book a showing. I can let ${agentName} know you're interested in case it comes back, and they can show you similar homes. Want me to do that?`, { blocked: listing.status });
    const dur = Number(s.showing_minutes || 30);
    // Appointment type: one named "Showing" if the account has it, else the first active in-person type, else none.
    let typeId: string | null = null;
    { const { data: t } = await supabase.from("appointment_types").select("id, name, mode").eq("account_id", acct.id).eq("is_active", true).order("created_at"); const types = t || []; typeId = (types.find((x: any) => /showing/i.test(x.name)) || types.find((x: any) => x.mode === "in_person") || types[0] || {}).id || null; }
    const where = `${listing.address}${listing.city ? ", " + listing.city : ""}${listing.zip ? " " + listing.zip : ""}`;
    const notes = `Showing — ${where}${listing.occupied ? " (OCCUPIED: give notice)" : ""}${listing.showing_instructions ? " · " + listing.showing_instructions : ""}`;
    const { data, error } = await supabase.rpc("donna_book_appointment", { p_account_id: acct.id, p_date: date, p_time: time, p_tz: tz, p_caller: callerName, p_phone: phone, p_notes: notes, p_language: args.language || null, p_appointment_type_id: typeId, p_mode: "in_person", p_location: where });
    if (error) { console.error("book", error.message); return say("Sorry, I ran into a problem booking that. Let me take your details and have the agent confirm a time with you."); }
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row || !row.ok) return say(`That time isn't open${row?.when_label ? ` (${row.when_label})` : ""}. Want me to check another time that day, or a different day?`, { booked: false });
    // Find the appointment we just made, tag it to the listing.
    let apptId: string | null = null;
    { const { data: ap } = await supabase.from("appointments").select("id").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(1).maybeSingle(); apptId = ap?.id || null; }
    const lead = await upsertLead(acct.id, { name: callerName, phone, email, kind: listing.listing_type === "for_rent" ? "renter" : "buyer", notes: `Showing booked for ${row.when_label} at ${listing.address}` }, listing, fromNumber);
    if (lead) await supabase.from("re_leads").update({ status: "showing_set", updated_at: now() }).eq("id", lead.id).in("status", ["new", "contacted"]);
    const iabs = await maybeSendIabs(acct, lead);
    // Showing agreement: already signed (last 180 days) → skip; else text it.
    let agreementSent = false, alreadySigned = false;
    const requireAgreement = s.require_showing_agreement !== false;
    if (phone) { const chk = await callFn("re-sign", { action: "signed_for", account_id: acct.id, phone }); alreadySigned = !!chk?.signed; }
    if (!alreadySigned && phone) { const r = await callFn("re-sign", { action: "doc_send", account_id: acct.id, kind: "showing_agreement", lead_id: lead?.id || null, listing_id: listing.id, appointment_id: apptId, signer_name: callerName, signer_phone: phone, signer_email: email, showing_date: row.when_label, agent_name: agentName }); agreementSent = !!r?.ok; }
    if (call.call_id) { const { data: c } = await supabase.from("calls").select("id").eq("twilio_call_sid", call.call_id).maybeSingle(); if (c?.id) await supabase.from("calls").update({ outcome: "booked" }).eq("id", c.id); }
    for (const p of await agentPhones(acct.id, listing.agent_user_id)) await sendText(acct.id, p, `Showing booked: ${listing.address}, ${row.when_label} — ${callerName}${phone ? " " + phone : ""}.${listing.occupied ? " Property is occupied; give notice." : ""}${agreementSent ? " Showing agreement texted; you'll get a text when it's signed." : alreadySigned ? " Agreement already on file." : ""} ${APP}`);
    const agreementLine = agreementSent ? (requireAgreement ? ` I've texted you a short showing agreement to sign — it takes a minute, and the showing is confirmed once it's in.` : ` I've texted you a short showing agreement to sign before you go.`) : "";
    return say(`You're set for ${row.when_label} at ${spokenAddr(listing.address)}.${agreementLine}${listing.occupied ? " The home is occupied, so the agent will confirm the time with the occupant." : ""} Please bring a photo ID.${iabs ? " I also texted you the Texas brokerage services notice — nothing to sign." : ""} Anything else?`, { booked: true, when: row.when_label, listing_id: listing.id, appointment_id: apptId, agreement_sent: agreementSent });
  }

  // ---------- send_application ----------
  if (tool === "send_application") {
    let listing: any = null; if (args.listing_id) { const { data } = await supabase.from("re_listings").select("*").eq("id", args.listing_id).eq("account_id", acct.id).maybeSingle(); listing = data; } if (!listing) { const rows = await findListings(acct.id, { query: args.address || args.listing_address || args.query, listing_type: "for_rent" }); listing = rows.length === 1 ? rows[0] : null; }
    if (!listing) return say("Which home is that for? Give me the street address.", { need: "address" });
    const callerName = String(args.caller_name || args.name || "").trim(); const phone = normPhone(args.phone || args.callback_number || fromNumber); const email = String(args.email || "").trim() || null;
    if (!callerName) return say("Who should I put the application under?", { need: "name" });
    if (!phone) return say("What's the best mobile number to text the application to?", { need: "phone" });
    const lead = await upsertLead(acct.id, { name: callerName, phone, email, kind: "renter", notes: `Asked for application — ${listing.address}` }, listing, fromNumber);
    const iabs = await maybeSendIabs(acct, lead);
    const r = await callFn("re-sign", { action: "doc_send", account_id: acct.id, kind: "rental_application", lead_id: lead?.id || null, listing_id: listing.id, signer_name: callerName, signer_phone: phone, signer_email: email, agent_name: agentName });
    if (!r?.ok) return say("I couldn't get the text out just now. Let me have the agent send it to you directly.", { sent: false });
    const fee = Number(s.application_fee_cents || 0);
    for (const p of await agentPhones(acct.id, listing.agent_user_id)) await sendText(acct.id, p, `Application sent: ${listing.address} — ${callerName} ${phone}. You'll get a text when it's signed. ${APP}`);
    return say(`Done — I just texted you the application for ${spokenAddr(listing.address)}. It takes about five minutes on your phone${fee ? `, and there's a ${money0(fee)} application fee once you've signed, paid by card` : ""}. ${agentName} reviews it as soon as it's in.${iabs ? " I also texted you the Texas brokerage services notice." : ""} Anything else?`, { sent: true, fee_cents: fee });
  }

  // ---------- send_iabs ----------
  if (tool === "send_iabs") {
    const phone = normPhone(args.phone || fromNumber); if (!phone || !s.iabs_url) return say("", { sent: false });
    const r = await callFn("re-sign", { action: "send_iabs", account_id: acct.id, phone, force: truthy(args.force) }); return say(r?.ok ? "I've texted you the brokerage services notice." : "", { sent: !!r?.ok });
  }

  return say("Sorry, I didn't catch that. What can I help you with?", { error: "unknown_tool", tool });
});
