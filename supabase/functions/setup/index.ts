import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — setup (v1). The "Donna proposes, you confirm" onboarding engine, shared by every vertical.
//
//   lookup  {query, website?, hint?}   -> find the business (Google Places) + read its website -> a PROPOSAL the wizard shows to confirm
//   apply   {proposal}                 -> write the confirmed proposal (account, assistant, hours, services, knowledge) in one go
//   test_call {to}                     -> Donna calls the owner's cell right now, as the account's own receptionist
//   forward_codes {carrier?}           -> tap-to-dial forwarding codes per carrier
//   forward_check {business_number}    -> Donna rings the business line; forward_status {since} tells whether it reached Donna
//   phone_setup_start {to}             -> Donna calls the owner and interviews them instead of the screen wizard
//   phone_setup_result {call_id, apply?} -> transcript -> proposal (and optionally applies it)
//   queue                              -> what is still unconfirmed, as questions Donna can ask later
//   ask {key}                          -> Donna texts the owner one open question
//   answer {key, text}                 -> file the owner's answer (from Today or a text reply) where it belongs
//
// Owners/admins only. Donna never invents facts: the proposal carries where each fact came from, and nothing is saved until confirmed.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const RETELL_API_KEY = Deno.env.get("RETELL_API_KEY") || "";
const RETELL_AGENT_ID = Deno.env.get("RETELL_AGENT_ID") || "agent_7e8792e07df78b6e366decb52a";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const MODEL = "claude-sonnet-4-6";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const rh = () => ({ Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" });
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (/^\d{10}$/.test(d)) d = "+1" + d; if (/^1\d{10}$/.test(d)) d = "+" + d; return d; };

let MAPS_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY") || ""; let mapsAt = 0;
async function mapsKey(): Promise<string> { if (MAPS_KEY) return MAPS_KEY; if (Date.now() - mapsAt < 60_000) return MAPS_KEY; mapsAt = Date.now(); try { const { data } = await supabase.from("app_secrets").select("value").eq("key", "google_maps_api_key").maybeSingle(); MAPS_KEY = String((data as any)?.value || "").trim(); } catch { /* */ } return MAPS_KEY; }
async function cfgGet(key: string): Promise<string> { const { data } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle(); return String((data as any)?.value || ""); }
async function cfgSet(key: string, value: string) { await supabase.from("app_config").upsert({ key, value }); }

async function resolveCaller(req: Request, body?: any): Promise<{ userId: string; accountId: string; role: string; email: string } | null> {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i); if (!m) return null;
  // Internal callers (service role, or the cron secret for ops checks) act as a named user.
  let internal = m[1] === SERVICE_ROLE;
  if (!internal && req.headers.get("x-cron-secret")) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); internal = !!(sec as any)?.value && req.headers.get("x-cron-secret") === (sec as any).value; }
  if (internal && body?.user_id) { const { data: me } = await supabase.from("users").select("id, account_id, role, email").eq("id", body.user_id).maybeSingle(); return me ? { userId: me.id, accountId: me.account_id, role: me.role, email: me.email || "" } : null; }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role").eq("id", user.id).maybeSingle();
  if (!(me as any)?.account_id) return null;
  return { userId: user.id, accountId: (me as any).account_id, role: (me as any).role, email: user.email || "" };
}
const isAdmin = (role: string) => ["owner", "admin", "manager"].includes(String(role || "").toLowerCase());

// ---------------------------------------------------------------- vertical knowledge
type Industry = "hair_salon" | "nail_salon" | "barbershop" | "spa" | "lash_brow" | "contractor" | "property_management" | "real_estate" | "restaurant" | "professional" | "other";
const PLACE_TYPE_TO_INDUSTRY: Record<string, { industry: Industry; trade?: string }> = {
  hair_salon: { industry: "hair_salon" }, hair_care: { industry: "hair_salon" }, beauty_salon: { industry: "hair_salon" }, barber_shop: { industry: "barbershop" }, nail_salon: { industry: "nail_salon" }, spa: { industry: "spa" }, massage: { industry: "spa" }, skin_care_clinic: { industry: "spa" }, wellness_center: { industry: "spa" },
  plumber: { industry: "contractor", trade: "plumbing" }, electrician: { industry: "contractor", trade: "electrical" }, roofing_contractor: { industry: "contractor", trade: "roofing" }, general_contractor: { industry: "contractor", trade: "remodeling" }, hvac_contractor: { industry: "contractor", trade: "hvac" }, painter: { industry: "contractor", trade: "painting" }, landscaper: { industry: "contractor", trade: "landscaping" }, pest_control_service: { industry: "contractor", trade: "pest" }, locksmith: { industry: "contractor", trade: "handyman" },
  real_estate_agency: { industry: "real_estate" }, real_estate_agent: { industry: "real_estate" }, property_management_company: { industry: "property_management" }, apartment_complex: { industry: "property_management" }, restaurant: { industry: "restaurant" }, lawyer: { industry: "professional" }, accounting: { industry: "professional" }, insurance_agency: { industry: "professional" }, dentist: { industry: "professional" }, veterinary_care: { industry: "professional" },
};
const SALONISH = new Set(["hair_salon", "nail_salon", "barbershop", "spa", "lash_brow"]);
const INDUSTRY_FEATURES: Record<string, Record<string, boolean>> = { property_management: { property_management: true, after_hours_emergency: true }, hair_salon: { salon: true }, nail_salon: { salon: true }, barbershop: { salon: true }, spa: { salon: true }, lash_brow: { salon: true } };
const STATE_TZ: Record<string, string> = { TX: "America/Chicago", OK: "America/Chicago", LA: "America/Chicago", AR: "America/Chicago", MO: "America/Chicago", KS: "America/Chicago", IL: "America/Chicago", WI: "America/Chicago", MN: "America/Chicago", IA: "America/Chicago", MS: "America/Chicago", AL: "America/Chicago", TN: "America/Chicago", NE: "America/Chicago", SD: "America/Chicago", ND: "America/Chicago", NY: "America/New_York", NJ: "America/New_York", PA: "America/New_York", FL: "America/New_York", GA: "America/New_York", NC: "America/New_York", SC: "America/New_York", VA: "America/New_York", MD: "America/New_York", DE: "America/New_York", DC: "America/New_York", MA: "America/New_York", CT: "America/New_York", RI: "America/New_York", NH: "America/New_York", VT: "America/New_York", ME: "America/New_York", OH: "America/New_York", MI: "America/New_York", IN: "America/New_York", KY: "America/New_York", WV: "America/New_York", CO: "America/Denver", UT: "America/Denver", NM: "America/Denver", WY: "America/Denver", MT: "America/Denver", ID: "America/Denver", AZ: "America/Phoenix", CA: "America/Los_Angeles", WA: "America/Los_Angeles", OR: "America/Los_Angeles", NV: "America/Los_Angeles", AK: "America/Anchorage", HI: "Pacific/Honolulu" };
function tzFor(state: string, utcOffsetMin: number | null): string {
  if (state && STATE_TZ[state]) return STATE_TZ[state];
  const m: Record<string, string> = { "-300": "America/New_York", "-240": "America/New_York", "-360": "America/Chicago", "-420": "America/Denver", "-480": "America/Los_Angeles", "-540": "America/Anchorage", "-600": "Pacific/Honolulu" };
  return (utcOffsetMin != null && m[String(utcOffsetMin)]) || "America/Chicago";
}

// ---------------------------------------------------------------- Google Places (new API)
async function placesSearch(query: string, hint: string): Promise<any[]> {
  const key = await mapsKey(); if (!key || !query) return [];
  const q = hint ? `${query} ${hint}` : query;
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.primaryType,places.types,places.rating,places.userRatingCount,places.googleMapsUri,places.utcOffsetMinutes,places.addressComponents,places.businessStatus" }, body: JSON.stringify({ textQuery: q, maxResultCount: 5, languageCode: "en", regionCode: "US" }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("places", r.status, JSON.stringify(j).slice(0, 300)); return []; }
  return Array.isArray(j.places) ? j.places : [];
}
function placeToBusiness(p: any) {
  const comps: any[] = p.addressComponents || [];
  const comp = (t: string) => (comps.find((c) => (c.types || []).includes(t)) || {});
  const state = comp("administrative_area_level_1").shortText || "";
  const periods: any[] = p.regularOpeningHours?.periods || [];
  const hours: Record<number, { open: string; close: string }> = {};
  for (const per of periods) { const d = per.open?.day; if (d == null) continue; const o = `${String(per.open.hour ?? 0).padStart(2, "0")}:${String(per.open.minute ?? 0).padStart(2, "0")}`; const c = per.close ? `${String(per.close.hour ?? 0).padStart(2, "0")}:${String(per.close.minute ?? 0).padStart(2, "0")}` : "23:59"; if (!hours[d] || o < hours[d].open) hours[d] = { open: o, close: hours[d] && hours[d].close > c ? hours[d].close : c }; }
  const types: string[] = [p.primaryType, ...(p.types || [])].filter(Boolean);
  let ind: { industry: Industry; trade?: string } | null = null; for (const t of types) { if (PLACE_TYPE_TO_INDUSTRY[t]) { ind = PLACE_TYPE_TO_INDUSTRY[t]; break; } }
  return {
    place_id: p.id, name: p.displayName?.text || "", address: p.formattedAddress || "", city: comp("locality").longText || "", state, zip: comp("postal_code").longText || "",
    phone: normPhone(p.internationalPhoneNumber || p.nationalPhoneNumber || ""), website: p.websiteUri || "", maps_url: p.googleMapsUri || "", rating: p.rating || null, reviews: p.userRatingCount || 0,
    tz: tzFor(state, p.utcOffsetMinutes ?? null), hours, types, industry_guess: ind?.industry || null, trade_guess: ind?.trade || null, open_status: p.businessStatus || "",
  };
}

// ---------------------------------------------------------------- website reading
function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
async function fetchText(url: string, ms = 8000): Promise<{ html: string; final: string } | null> {
  try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms); const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; DonnaSetup/1.0; +https://sidekicklogistics.com)" } }); clearTimeout(t); if (!r.ok) return null; const ct = r.headers.get("content-type") || ""; if (!/html|text/i.test(ct)) return null; const html = await r.text(); return { html: html.slice(0, 600_000), final: r.url }; } catch { return null; }
}
async function readWebsite(site: string): Promise<{ text: string; pages: string[] } | null> {
  let url = String(site || "").trim(); if (!url) return null; if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const home = await fetchText(url); if (!home) return null;
  const base = new URL(home.final); const pages = [home.final]; const seen = new Set([home.final.replace(/\/$/, "")]);
  const links = [...home.html.matchAll(/href=["']([^"'#?]+)["']/gi)].map((m) => m[1]);
  const want = /service|price|pricing|menu|rates|team|staff|stylist|our-|about|book|contact|hours|faq|special|package|area/i;
  const picked: string[] = [];
  for (const l of links) { try { const u = new URL(l, base); if (u.host !== base.host) continue; const k = u.href.replace(/\/$/, ""); if (seen.has(k) || !want.test(u.pathname) || /\.(pdf|jpg|png|gif|svg|css|js)$/i.test(u.pathname)) continue; seen.add(k); picked.push(u.href); if (picked.length >= 6) break; } catch { /* */ } }
  let text = `PAGE ${home.final}\n` + stripHtml(home.html).slice(0, 14000);
  const extra = await Promise.all(picked.map((p) => fetchText(p, 7000)));
  extra.forEach((e, i) => { if (e) { pages.push(picked[i]); text += `\n\nPAGE ${picked[i]}\n` + stripHtml(e.html).slice(0, 9000); } });
  return { text: text.slice(0, 60_000), pages };
}
async function llmJson(system: string, user: string, maxTokens = 3000): Promise<any> {
  if (!ANTHROPIC_KEY) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }) });
  const j: any = await r.json().catch(() => ({})); if (!r.ok) { console.error("llm", r.status, JSON.stringify(j).slice(0, 300)); return null; }
  const text = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}"); if (a < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const EXTRACT_SYSTEM = `You read a small business's website text and pull out ONLY facts that are actually stated, for an AI phone receptionist's setup. Never invent. Leave fields empty when the site does not say.
Return ONLY JSON: {"industry":"hair_salon|nail_salon|barbershop|spa|lash_brow|contractor|property_management|real_estate|restaurant|professional|other","trades":["hvac","plumbing","electrical","landscaping","lawn","pool","handyman","roofing","painting","remodeling","flooring","fencing","concrete","garage_door","appliance","pest","pressure_washing","windows","gutters","tree"],"tagline":"one sentence describing the business in its own words","services":[{"name":"","duration_min":30,"price":"as written, e.g. $45 or from $120, or empty","category":""}],"team":[{"name":"","role":""}],"service_area":"cities/areas served, if stated","hours_text":"hours if stated, verbatim-ish","faq":[{"q":"a question a caller would ask","a":"the answer, from the site"}],"policies":"cancellation/deposit/payment policies if stated","languages":["en","es"]}
Rules: services max 40, keep the site's names and prices; duration_min only if stated or obvious (haircut 30-45, color 90-120, estimate visit 60) else 30. faq max 12, short answers. team only real people with names. trades only for contractors.`;

// ---------------------------------------------------------------- proposal helpers
function dayHoursToWizard(hours: Record<number, { open: string; close: string }>) {
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => !!hours[d]);
  const opens = Object.values(hours).map((h) => h.open).sort(); const closes = Object.values(hours).map((h) => h.close).sort();
  return { days, open: opens[0] || "09:00", close: closes[closes.length - 1] || "17:00", per_day: hours };
}
async function buildProposal(acctId: string, query: string, website: string, hint: string) {
  const [places] = await Promise.all([placesSearch(query, hint)]);
  const candidates = places.map(placeToBusiness).filter((b) => b.name);
  const best = candidates[0] || null;
  const site = website || best?.website || "";
  const web = site ? await readWebsite(site) : null;
  let ext: any = null;
  if (web) ext = await llmJson(EXTRACT_SYSTEM, `Business name: ${best?.name || query}\n\nWEBSITE TEXT:\n${web.text}\n\nReturn the JSON now.`);
  const industry: Industry = (ext?.industry && ext.industry !== "other" ? ext.industry : null) || best?.industry_guess || (ext?.industry || "other");
  const trades: string[] = Array.from(new Set([...(Array.isArray(ext?.trades) ? ext.trades : []), ...(best?.trade_guess ? [best.trade_guess] : [])]));
  const services = (Array.isArray(ext?.services) ? ext.services : []).filter((s: any) => s && s.name).slice(0, 40).map((s: any) => ({ name: String(s.name).slice(0, 80), duration_min: Math.max(10, Math.min(480, Number(s.duration_min) || 30)), price: String(s.price || "").slice(0, 40), category: String(s.category || "").slice(0, 40), keep: true }));
  const team = (Array.isArray(ext?.team) ? ext.team : []).filter((t: any) => t && t.name).slice(0, 25).map((t: any) => ({ name: String(t.name).slice(0, 60), role: String(t.role || "").slice(0, 60), keep: true }));
  const faq = (Array.isArray(ext?.faq) ? ext.faq : []).filter((f: any) => f && f.q && f.a).slice(0, 12).map((f: any) => ({ q: String(f.q).slice(0, 200), a: String(f.a).slice(0, 600), keep: true }));
  return {
    found: !!best, candidates: candidates.slice(0, 4),
    business: best ? { name: best.name, phone: best.phone, address: best.address, city: best.city, state: best.state, zip: best.zip, website: site, maps_url: best.maps_url, place_id: best.place_id, rating: best.rating, reviews: best.reviews, tz: best.tz } : { name: query, phone: "", address: "", city: "", state: "", zip: "", website: site, maps_url: "", place_id: "", rating: null, reviews: 0, tz: "America/Chicago" },
    industry, trades, hours: best ? dayHoursToWizard(best.hours) : { days: [false, true, true, true, true, true, false], open: "09:00", close: "17:00", per_day: {} },
    hours_source: best && Object.keys(best.hours).length ? "google" : (ext?.hours_text ? "website" : "default"), hours_text: ext?.hours_text || "",
    tagline: String(ext?.tagline || "").slice(0, 240), service_area: String(ext?.service_area || "").slice(0, 240), policies: String(ext?.policies || "").slice(0, 600), languages: Array.isArray(ext?.languages) && ext.languages.length ? ext.languages : ["en"],
    services, team, faq,
    sources: { google: !!best, website: !!web, pages: web?.pages || [] },
  };
}

// ---------------------------------------------------------------- apply a confirmed proposal
async function applyProposal(caller: { userId: string; accountId: string; email: string }, p: any) {
  const { data: acct } = await supabase.from("accounts").select("id, name, industry, settings").eq("id", caller.accountId).maybeSingle();
  if (!acct) return { ok: false, error: "no_account" };
  const b = p.business || {}; const industry: string = p.industry || acct.industry || "other";
  const settings: any = Object.assign({}, acct.settings || {});
  settings.timezone = b.tz || settings.timezone || "America/Chicago";
  settings.business = Object.assign({}, settings.business || {}, { phone: b.phone || settings.business?.phone || "", address: b.address || "", website: b.website || "", place_id: b.place_id || "", maps_url: b.maps_url || "", tagline: p.tagline || "", service_area: p.service_area || "" });
  settings.address = b.address || settings.address || "";
  const feat = Object.assign({}, settings.features || {}, INDUSTRY_FEATURES[industry] || {});
  if (industry === "property_management") { settings.property_types = Array.isArray(p.pm_types) && p.pm_types.length ? p.pm_types : (settings.property_types || ["residential"]); delete feat.salon; }
  if (industry === "real_estate") { settings.real_estate = Object.assign({ application_fee_cents: 0 }, settings.real_estate || {}, { lines: Array.isArray(p.re_lines) && p.re_lines.length ? p.re_lines : (settings.real_estate?.lines || ["residential"]) }); delete feat.salon; }
  if (industry === "contractor") { settings.trades = Array.isArray(p.trades) ? p.trades : (settings.trades || []); settings.contractor = Object.assign({ trip_fee_cents: 0, trip_fee_waived_if_work: true, after_hours_multiplier: 1.5, day_start_hour: 7, day_end_hour: 19 }, settings.contractor || {}); }
  if (SALONISH.has(industry)) delete feat.property_management;
  settings.features = feat;
  if (!settings.sms) settings.sms = { enabled: true, confirmations: true, reminders: true };
  if (!settings.alert_email && caller.email) settings.alert_email = caller.email;
  settings.onboarding = Object.assign({}, settings.onboarding || {}, { wizard: "v2", proposal_applied_at: new Date().toISOString(), team_found: (p.team || []).filter((t: any) => t.keep !== false), sources: p.sources || {}, policies: p.policies || "" });
  const name = String(b.name || acct.name || "").slice(0, 120);
  const { error: e1 } = await supabase.from("accounts").update({ name, industry, settings }).eq("id", acct.id);
  if (e1) return { ok: false, error: e1.message };
  // Owner
  if (p.owner) await supabase.from("users").update({ full_name: String(p.owner.name || "").slice(0, 120) || undefined, phone: p.owner.phone ? normPhone(p.owner.phone) : undefined, timezone: settings.timezone }).eq("id", caller.userId);
  // Assistant (voice by vertical; the owner can change it later)
  const { data: asst } = await supabase.from("assistants").select("id, routing").eq("account_id", acct.id).order("created_at").limit(1).maybeSingle();
  const voice = p.voice || (industry === "contractor" ? "pro-female" : "warm-female");
  const routing = Object.assign({}, (asst as any)?.routing || {}, { recording_notice: true });
  if (p.transfer_number) routing.transfer = Object.assign({}, routing.transfer || {}, { enabled: true, number: normPhone(p.transfer_number) });
  const arow: any = { assistant_name: p.assistant_name || "Donna", greeting_label: name, voice_id: voice, languages: Array.isArray(p.languages) && p.languages.length ? p.languages : ["en"], is_active: true, routing };
  let assistantId = (asst as any)?.id;
  if (assistantId) await supabase.from("assistants").update(arow).eq("id", assistantId);
  else { const { data: na } = await supabase.from("assistants").insert({ ...arow, account_id: acct.id, owner_user_id: caller.userId }).select("id").maybeSingle(); assistantId = na?.id; }
  // Hours -> the owner's working + bookable rules (per day when Google gave them)
  const h = p.hours || {}; const perDay: Record<string, { open: string; close: string }> = h.per_day || {};
  const rows: any[] = [];
  for (let d = 0; d < 7; d++) { const on = Array.isArray(h.days) ? !!h.days[d] : false; if (!on) continue; const o = (perDay[d]?.open || h.open || "09:00").slice(0, 5), c = (perDay[d]?.close || h.close || "17:00").slice(0, 5); if (c <= o) continue; rows.push({ account_id: acct.id, user_id: caller.userId, rule_type: "working", day_of_week: d, start_time: o, end_time: c }); rows.push({ account_id: acct.id, user_id: caller.userId, rule_type: "bookable", appointment_type_id: null, day_of_week: d, start_time: o, end_time: c }); }
  if (rows.length) { await supabase.from("availability_rules").delete().eq("user_id", caller.userId); await supabase.from("availability_rules").insert(rows); }
  // Services -> appointment types (skip ones that already exist by name)
  const { data: existing } = await supabase.from("appointment_types").select("name").eq("account_id", acct.id);
  const have = new Set((existing || []).map((t: any) => String(t.name).toLowerCase()));
  const svc = (p.services || []).filter((s: any) => s && s.name && s.keep !== false && !have.has(String(s.name).toLowerCase())).slice(0, 40);
  if (svc.length) await supabase.from("appointment_types").insert(svc.map((s: any) => ({ account_id: acct.id, name: String(s.name).slice(0, 80), mode: "in_person", default_duration_min: Math.max(10, Math.min(480, Number(s.duration_min) || 30)), buffer_before_min: 0, buffer_after_min: 0, requires_travel: industry === "contractor", price: s.price ? String(s.price).slice(0, 40) : null, category: s.category ? String(s.category).slice(0, 40) : null, is_public: true })));
  // Knowledge: tagline, policies, service area, FAQ — confirmed on screen, so approved.
  const facts: { title: string; content: string }[] = [];
  if (p.tagline) facts.push({ title: "About us", content: String(p.tagline) });
  if (p.service_area) facts.push({ title: "Service area", content: `Service area: ${p.service_area}` });
  if (p.policies) facts.push({ title: "Policies", content: String(p.policies) });
  for (const f of (p.faq || []).filter((f: any) => f && f.q && f.a && f.keep !== false)) facts.push({ title: String(f.q).slice(0, 200), content: `FAQ: ${f.q} ${f.a}` });
  let knowledge = 0;
  if (facts.length) {
    try {
      const { data: doc } = await supabase.from("documents").insert({ account_id: acct.id, uploaded_by: caller.userId, filename: "Setup — from your website and listing", doc_type: "interview", storage_path: null, extracted_text: facts.map((f) => f.title + ": " + f.content).join("\n") }).select("id").maybeSingle();
      if (doc?.id) {
        // Embeddings are filled in by the knowledge-embed-pending sweep (every 2 min); embedding inline blew the function's memory.
        const { error: ke } = await supabase.from("knowledge_entries").insert(facts.map((f) => ({ account_id: acct.id, created_by: caller.userId, source: "document", title: f.title, content: f.content, document_id: doc.id, approved: true })));
        if (ke) console.error("kb insert", ke.message); else { knowledge = facts.length; fetch(`${SELF}/knowledge-embed-pending`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: acct.id }) }).catch(() => {}); }
      }
    } catch (e) { console.error("knowledge", String(e)); }
  }
  // Vertical preset (persona, starter types, drafts) — idempotent.
  try { await fetch(`${SELF}/apply-preset`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ industry, account_id: acct.id, user_id: caller.userId }) }); } catch { /* */ }
  return { ok: true, assistant_id: assistantId, services_added: svc.length, knowledge_added: knowledge, timezone: settings.timezone };
}

// ---------------------------------------------------------------- what is still open (the "Donna asks you later" queue)
async function openQueue(accountId: string) {
  const { data: acct } = await supabase.from("accounts").select("name, industry, settings").eq("id", accountId).maybeSingle();
  const s: any = acct?.settings || {}; const ob: any = s.onboarding || {}; const asked: Record<string, string> = ob.asked || {}; const answered: Record<string, string> = ob.answered || {};
  const [{ data: types }, { data: asst }, { data: staff }, { data: pa }] = await Promise.all([
    supabase.from("appointment_types").select("id, name, price").eq("account_id", accountId).eq("is_active", true),
    supabase.from("assistants").select("twilio_number, routing").eq("account_id", accountId).limit(1).maybeSingle(),
    supabase.from("users").select("id").eq("account_id", accountId).eq("is_active", true),
    supabase.from("payment_accounts").select("charges_enabled").eq("account_id", accountId).maybeSingle(),
  ]);
  const items: { key: string; question: string; why: string; kind: string }[] = [];
  const noPrice = (types || []).filter((t: any) => !t.price);
  if ((types || []).length === 0) items.push({ key: "services", question: `What are the main things people call ${acct?.name || "you"} for, and roughly what each costs?`, why: "So Donna can answer \"how much is it?\" and book the right amount of time.", kind: "services" });
  else if (noPrice.length) items.push({ key: "prices", question: `What do you charge for ${noPrice.slice(0, 3).map((t: any) => t.name).join(", ")}${noPrice.length > 3 ? " and a few others" : ""}? (Reply with the prices, or "varies".)`, why: "Donna answers price questions on the phone.", kind: "prices" });
  if (!(asst as any)?.routing?.transfer?.enabled) items.push({ key: "transfer", question: "When a caller really needs a person, should Donna try your cell first, or just take a message? (Reply with a number, or \"message\".)", why: "Live transfers vs messages.", kind: "transfer" });
  if ((ob.team_found || []).length && (staff || []).length <= 1) items.push({ key: "team", question: `I saw ${(ob.team_found || []).slice(0, 3).map((t: any) => t.name).join(", ")} on your site. Want me to set them up so clients can book with them? (Reply with their mobile numbers.)`, why: "Team booking.", kind: "team" });
  if (acct?.industry === "contractor") { if (!s.contractor?.after_hours_policy) items.push({ key: "after_hours", question: "After hours, do you take emergency calls? If yes, who should Donna page, and is there an after-hours rate?", why: "Emergency routing.", kind: "after_hours" }); if (!(s.contractor?.trip_fee_cents > 0) && s.contractor?.trip_fee_cents !== 0) items.push({ key: "trip_fee", question: "Do you charge a trip or service-call fee? How much, and is it waived if they go ahead with the work?", why: "Donna quotes it on the phone.", kind: "trip_fee" }); }
  if (acct?.industry === "property_management" && !s.pm?.emergency_policy) items.push({ key: "pm_emergency", question: "For tenant emergencies at night (no heat, flooding, lockout), who does Donna call first, and is there a vendor she can dispatch directly?", why: "After-hours dispatch.", kind: "pm_emergency" });
  if (!pa?.charges_enabled && ["contractor", "hair_salon", "nail_salon", "barbershop", "spa", "lash_brow"].includes(acct?.industry || "")) items.push({ key: "stripe", question: "Want Donna to take payments (pay links, cards on file, tips)? It takes a few minutes to connect your Stripe from the dashboard.", why: "Payments.", kind: "link" });
  if (!(asst as any)?.twilio_number) items.push({ key: "number", question: "Your Donna number isn't set up yet — open the dashboard and tap \"Keep your number\" to finish.", why: "Nothing works without a number.", kind: "link" });
  return items.map((i) => ({ ...i, asked_at: asked[i.key] || null, answered_at: answered[i.key] || null })).filter((i) => !i.answered_at);
}

// ---------------------------------------------------------------- Retell helpers (outbound calls)
async function ensureOutboundNumber(): Promise<string> {
  let n = await cfgGet("qa_tester_number"); if (n) return n;
  const r = await fetch("https://api.retellai.com/create-phone-number", { method: "POST", headers: rh(), body: JSON.stringify({ nickname: "Donna outbound" }) });
  const j: any = await r.json().catch(() => ({})); if (j?.phone_number) { n = j.phone_number; await cfgSet("qa_tester_number", n); }
  return n;
}
const SETUP_PROMPT = `You are Donna, a friendly AI receptionist, calling {{owner_name}} who just signed up for you to answer the phone for {{business_name}} ({{vertical_label}}). This call IS their setup: you ask a few short questions, one at a time, and that is all they need to do.

What you already know (do not re-ask; confirm briefly if useful): {{known}}

Ask these, in order, skipping any already answered: {{questions}}

How to behave: warm, quick, plain spoken. One question per turn. Accept whatever they say, repeat back numbers and prices once, do not lecture. If they say "I don't know" or "skip", move on. After the last question say you've got everything, that you'll be answering their phone from now on, and that you'll text them a summary. Then call end_call. Keep the whole call under five minutes. Do not say you are an AI language model; you are Donna, their receptionist.`;
async function ensureSetupAgent(): Promise<{ agent_id: string; llm_id: string } | null> {
  let llm = await cfgGet("setup_llm_id"), agent = await cfgGet("setup_agent_id");
  if (!llm) { const r = await fetch("https://api.retellai.com/create-retell-llm", { method: "POST", headers: rh(), body: JSON.stringify({ general_prompt: SETUP_PROMPT, begin_message: "Hi {{owner_name}}, it's Donna — your new receptionist for {{business_name}}. Got three minutes? I'll ask a few quick questions and then I'm ready to answer your phones.", general_tools: [{ type: "end_call", name: "end_call", description: "End the call once every question is answered or the owner wants to stop." }] }) }); const j: any = await r.json().catch(() => ({})); if (!j?.llm_id) { console.error("setup llm", JSON.stringify(j).slice(0, 300)); return null; } llm = j.llm_id; await cfgSet("setup_llm_id", llm); }
  if (!agent) { const r = await fetch("https://api.retellai.com/create-agent", { method: "POST", headers: rh(), body: JSON.stringify({ response_engine: { type: "retell-llm", llm_id: llm }, voice_id: "minimax-Cimo", agent_name: "Donna Setup Interview", webhook_url: `${SELF}/retell-call-events` }) }); const j: any = await r.json().catch(() => ({})); if (!j?.agent_id) { console.error("setup agent", JSON.stringify(j).slice(0, 300)); return null; } agent = j.agent_id; await cfgSet("setup_agent_id", agent); }
  return { agent_id: agent, llm_id: llm };
}
const CHECK_PROMPT = `You are Donna. This is a 15-second automated check of call forwarding. If a human answers, say: "Hi, this is Donna checking your call forwarding. It looks like calls to this line aren't reaching me yet — I'll text you the steps. Bye for now!" then call end_call immediately. If voicemail answers, say nothing and call end_call.`;
async function ensureCheckAgent(): Promise<string | null> {
  let agent = await cfgGet("setup_check_agent_id"); if (agent) return agent;
  const r0 = await fetch("https://api.retellai.com/create-retell-llm", { method: "POST", headers: rh(), body: JSON.stringify({ general_prompt: CHECK_PROMPT, general_tools: [{ type: "end_call", name: "end_call", description: "Hang up." }] }) }); const l: any = await r0.json().catch(() => ({})); if (!l?.llm_id) return null;
  const r = await fetch("https://api.retellai.com/create-agent", { method: "POST", headers: rh(), body: JSON.stringify({ response_engine: { type: "retell-llm", llm_id: l.llm_id }, voice_id: "minimax-Cimo", agent_name: "Donna Forwarding Check", max_call_duration_ms: 30000 }) }); const j: any = await r.json().catch(() => ({})); if (!j?.agent_id) return null;
  agent = j.agent_id; await cfgSet("setup_check_agent_id", agent); return agent;
}
const VERTICAL_LABEL: Record<string, string> = { hair_salon: "a hair salon", nail_salon: "a nail salon", barbershop: "a barbershop", spa: "a spa", lash_brow: "a lash and brow studio", contractor: "a contractor", property_management: "a property management company", real_estate: "a real estate business", restaurant: "a restaurant", professional: "a professional services firm", other: "a small business" };
function interviewQuestions(industry: string, known: any): string[] {
  const q: string[] = [];
  if (!known.hours) q.push("What days and hours are you open?");
  if (!known.services) q.push(SALONISH.has(industry) ? "What are your main services, and about how much is each? For example a haircut, color, or whatever you do most." : industry === "contractor" ? "What kind of work do you do most, and do you charge a trip or service-call fee?" : industry === "property_management" ? "Roughly how many units or communities do you manage, and are they homes, apartments, or HOAs?" : industry === "real_estate" ? "Do you mainly work with buyers, sellers, renters, or all three, and which areas?" : "What are the main things people call you about?");
  if (SALONISH.has(industry) && !known.team) q.push("Is it just you, or do other people take appointments too? If so, who?");
  if (industry === "contractor") q.push("After hours, do you take emergency calls? If so, who should I page and is there an after-hours rate?");
  if (industry === "property_management") q.push("For a tenant emergency at night, like no heat or a leak, who do I call first?");
  q.push("When a caller really needs a person, should I try your cell, or take a message and text it to you?");
  q.push("Is there anything you want me to always tell callers, or never say?");
  return q;
}
const EXTRACT_CALL_SYSTEM = `You turn a phone interview between Donna (an AI receptionist) and a business owner into structured setup facts. Only what the OWNER said. Never invent.
Return ONLY JSON: {"hours":{"days":[sun,mon,tue,wed,thu,fri,sat as true/false],"open":"HH:MM","close":"HH:MM"} or null,"services":[{"name":"","duration_min":30,"price":"$45 or empty"}],"team":[{"name":"","role":""}],"transfer":{"mode":"cell|message","number":"+1... if given"},"after_hours":"what they said, or empty","trip_fee":"what they said, or empty","always_say":"","never_say":"","service_area":"","notes":"anything else useful, one or two sentences","summary_for_owner":"2 sentences in Donna's voice summarizing what she set up"}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "");
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  if (!isAdmin(caller.role)) return json({ ok: false, error: "admins_only" }, 403);

  if (action === "lookup") {
    const query = String(body.query || "").trim().slice(0, 160); const website = String(body.website || "").trim().slice(0, 200); const hint = String(body.hint || "").trim().slice(0, 80);
    if (!query && !website) return json({ ok: false, error: "need_query" }, 400);
    try { const p = await buildProposal(caller.accountId, query || website.replace(/^https?:\/\//, ""), website, hint); return json({ ok: true, proposal: p, has_places: !!(await mapsKey()), has_llm: !!ANTHROPIC_KEY }); }
    catch (e) { console.error("lookup", e); return json({ ok: false, error: "lookup_failed", detail: String((e as any)?.message || e) }, 500); }
  }
  if (action === "apply") { const r = await applyProposal(caller, body.proposal || {}); return json(r, r.ok ? 200 : 400); }

  if (action === "queue") return json({ ok: true, items: await openQueue(caller.accountId) });
  if (action === "ask") {
    const key = String(body.key || ""); const items = await openQueue(caller.accountId); const it = items.find((i) => i.key === key); if (!it) return json({ ok: false, error: "not_open" });
    const { data: me } = await supabase.from("users").select("phone, full_name").eq("id", caller.userId).maybeSingle(); const to = normPhone((me as any)?.phone || body.phone || ""); if (!to) return json({ ok: false, error: "no_phone" });
    const { data: acct } = await supabase.from("accounts").select("name, settings").eq("id", caller.accountId).maybeSingle();
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: caller.accountId, to, body: `Hi${(me as any)?.full_name ? " " + String((me as any).full_name).split(" ")[0] : ""}, it's Donna (setting up for ${acct?.name || "you"}). ${it.question}` }) });
    const j: any = await r.json().catch(() => ({}));
    const settings: any = Object.assign({}, acct?.settings || {}); settings.onboarding = Object.assign({}, settings.onboarding || {}); settings.onboarding.asked = Object.assign({}, settings.onboarding.asked || {}, { [key]: new Date().toISOString() }); settings.onboarding.pending_question = key;
    await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
    return json({ ok: !!j?.ok, sent: !!j?.ok, warning: j?.warning || null });
  }
  if (action === "answered") { // owner typed the answer in the dashboard, or we saw a reply; mark it so it is not asked again
    const key = String(body.key || ""); const { data: acct } = await supabase.from("accounts").select("settings").eq("id", caller.accountId).maybeSingle(); const settings: any = Object.assign({}, acct?.settings || {}); settings.onboarding = Object.assign({}, settings.onboarding || {}); settings.onboarding.answered = Object.assign({}, settings.onboarding.answered || {}, { [key]: new Date().toISOString() }); await supabase.from("accounts").update({ settings }).eq("id", caller.accountId); return json({ ok: true });
  }

  if (action === "answer") {
    // The owner answered one open question (on Today, or by text). File it where it belongs, then mark it answered.
    const key = String(body.key || ""); const text = String(body.text || "").trim().slice(0, 1500); if (!key || !text) return json({ ok: false, error: "need_text" }, 400);
    const { data: acct } = await supabase.from("accounts").select("name, industry, settings").eq("id", caller.accountId).maybeSingle(); const settings: any = Object.assign({}, acct?.settings || {});
    let note = "Got it.";
    const { data: asst } = await supabase.from("assistants").select("id, routing").eq("account_id", caller.accountId).limit(1).maybeSingle();
    const phoneIn = normPhone(text.match(/\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/)?.[0] || "");
    if (key === "transfer" && asst) {
      const routing = Object.assign({}, (asst as any).routing || {}); const msgOnly = /message|text me|no transfer|don't|dont/i.test(text) && !phoneIn;
      routing.transfer = Object.assign({}, routing.transfer || {}, { enabled: !msgOnly && !!phoneIn, number: phoneIn || routing.transfer?.number || "" });
      await supabase.from("assistants").update({ routing }).eq("id", (asst as any).id); note = msgOnly ? "She'll take a message and text it to you." : (phoneIn ? `She'll try ${phoneIn} first, then take a message.` : "Saved as a note; add a number to turn transfers on.");
    } else if (key === "trip_fee" && acct?.industry === "contractor") {
      const amt = text.match(/\$?\s*(\d{1,4})(?:\.\d{2})?/); const none = /no\b|none|don't|dont|free/i.test(text) && !amt;
      settings.contractor = Object.assign({}, settings.contractor || {}, { trip_fee_cents: none ? 0 : (amt ? Math.round(Number(amt[1]) * 100) : (settings.contractor?.trip_fee_cents || 0)), trip_fee_waived_if_work: !/not waived|still charge|non-?refundable/i.test(text) }); note = none ? "No trip fee. Donna won't mention one." : (amt ? `Trip fee $${amt[1]}${settings.contractor.trip_fee_waived_if_work ? ", waived if they go ahead" : ""}.` : "Saved.");
    } else if (key === "after_hours" && acct?.industry === "contractor") {
      settings.contractor = Object.assign({}, settings.contractor || {}, { after_hours_policy: text, ...(phoneIn ? { after_hours_page_phone: phoneIn } : {}) }); note = phoneIn ? `After hours she'll page ${phoneIn}.` : "Saved your after-hours policy.";
    } else if (key === "pm_emergency") { settings.pm = Object.assign({}, settings.pm || {}, { emergency_policy: text, ...(phoneIn ? { emergency_phone: phoneIn } : {}) }); note = "Saved your emergency routing."; }
    else if (key === "prices" || key === "services") {
      // Map "haircut 45, color from 120" onto the account's services with the model; add new ones it names.
      const { data: types } = await supabase.from("appointment_types").select("id, name, price").eq("account_id", caller.accountId).eq("is_active", true);
      const ext = await llmJson(`You map an owner's free-text answer about services and prices onto a list of existing services. Return ONLY JSON: {"updates":[{"id":"existing id","price":"as the owner said, e.g. $45 or from $120"}],"new":[{"name":"","price":"","duration_min":30}]}. Only use prices the owner actually gave. Never invent.`, `Existing services: ${JSON.stringify((types || []).map((t: any) => ({ id: t.id, name: t.name, price: t.price })))}\n\nOwner said: ${text}\n\nReturn the JSON now.`, 1500);
      let n = 0; for (const u of (ext?.updates || [])) { if (u?.id && u?.price) { await supabase.from("appointment_types").update({ price: String(u.price).slice(0, 40) }).eq("id", u.id).eq("account_id", caller.accountId); n++; } }
      const fresh = (ext?.new || []).filter((x: any) => x?.name).slice(0, 15); if (fresh.length) await supabase.from("appointment_types").insert(fresh.map((x: any) => ({ account_id: caller.accountId, name: String(x.name).slice(0, 80), mode: "in_person", default_duration_min: Math.max(10, Math.min(480, Number(x.duration_min) || 30)), buffer_before_min: 0, buffer_after_min: 0, requires_travel: acct?.industry === "contractor", price: x.price ? String(x.price).slice(0, 40) : null, is_public: true })));
      note = `Updated ${n} price${n === 1 ? "" : "s"}${fresh.length ? ` and added ${fresh.length} service${fresh.length === 1 ? "" : "s"}` : ""}.`;
    } else if (key === "team") { settings.onboarding = Object.assign({}, settings.onboarding || {}, { team_numbers_note: text }); note = "Thanks — add them under Team when you're ready, or I'll walk you through it."; }
    // Everything also becomes a knowledge fact so Donna can say it on the phone.
    try { const { data: doc } = await supabase.from("documents").insert({ account_id: caller.accountId, uploaded_by: caller.userId, filename: `Setup answer — ${key}`, doc_type: "interview", storage_path: null, extracted_text: text }).select("id").maybeSingle(); if (doc?.id) { const title = ({ transfer: "Reaching a person", trip_fee: "Trip fee", after_hours: "After hours", pm_emergency: "Emergencies", prices: "Prices", services: "Services", team: "Team" } as any)[key] || "Setup note"; await supabase.from("knowledge_entries").insert({ account_id: caller.accountId, created_by: caller.userId, source: "document", title, content: text, document_id: doc.id, approved: true }); } } catch (e) { console.error("answer kb", String(e)); }
    settings.onboarding = Object.assign({}, settings.onboarding || {}); settings.onboarding.answered = Object.assign({}, settings.onboarding.answered || {}, { [key]: new Date().toISOString() }); settings.onboarding.answers = Object.assign({}, settings.onboarding.answers || {}, { [key]: text }); if (settings.onboarding.pending_question === key) settings.onboarding.pending_question = null;
    await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
    return json({ ok: true, note });
  }

  if (action === "forward_codes") {
    const codes = {
      att_wireless: { name: "AT&T (cell)", all: "**21*{n}#", busy_noanswer: "**61*{n}#  then  **67*{n}#", off: "##21#  ##61#  ##67#" },
      verizon: { name: "Verizon (cell)", all: "*72{n}", busy_noanswer: "*71{n}", off: "*73" },
      tmobile: { name: "T-Mobile (cell)", all: "**21*{n}#", busy_noanswer: "**61*{n}#  then  **67*{n}#", off: "##21#  ##61#  ##67#" },
      landline: { name: "Landline / VoIP (AT&T, Spectrum, Frontier, Comcast, Ooma…)", all: "*72{n}", busy_noanswer: "*92{n}  (no answer)  ·  *90{n}  (busy)", off: "*73" },
      google_voice: { name: "Google Voice / RingCentral / Grasshopper", all: "Set forwarding in the app: Settings → Calls → Forward to {n}", busy_noanswer: "Same screen: forward when unanswered", off: "Turn it off in the same screen" },
    };
    return json({ ok: true, codes });
  }
  if (action === "forward_check") {
    const biz = normPhone(body.business_number || ""); if (!biz) return json({ ok: false, error: "no_number" });
    if (!RETELL_API_KEY) return json({ ok: false, error: "no_retell" });
    const from = await ensureOutboundNumber(); const agent = await ensureCheckAgent(); if (!from || !agent) return json({ ok: false, error: "no_outbound" });
    const r = await fetch("https://api.retellai.com/v2/create-phone-call", { method: "POST", headers: rh(), body: JSON.stringify({ from_number: from, to_number: biz, override_agent_id: agent, metadata: { kind: "forward_check", account_id: caller.accountId } }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.call_id) return json({ ok: false, error: "call_failed", detail: j });
    return json({ ok: true, call_id: j.call_id, from, since: new Date(Date.now() - 5000).toISOString() });
  }
  if (action === "forward_status") {
    const since = String(body.since || new Date(Date.now() - 120000).toISOString()); const from = await cfgGet("qa_tester_number");
    const { data: asst } = await supabase.from("assistants").select("twilio_number").eq("account_id", caller.accountId).limit(1).maybeSingle();
    const { data: hit } = await supabase.from("calls").select("id, started_at").eq("account_id", caller.accountId).eq("from_number", from).gte("started_at", since).limit(1).maybeSingle();
    if (hit) { const { data: acct } = await supabase.from("accounts").select("settings").eq("id", caller.accountId).maybeSingle(); const settings: any = Object.assign({}, acct?.settings || {}); settings.phone = Object.assign({}, settings.phone || {}, { forwarding_verified_at: new Date().toISOString() }); await supabase.from("accounts").update({ settings }).eq("id", caller.accountId); }
    return json({ ok: true, forwarded: !!hit, donna_number: (asst as any)?.twilio_number || null });
  }

  if (action === "test_call" || action === "phone_setup_start") {
    const to = normPhone(body.to || ""); if (!to) return json({ ok: false, error: "no_number" });
    if (!RETELL_API_KEY) return json({ ok: false, error: "no_retell" });
    const { data: acct } = await supabase.from("accounts").select("name, industry, settings").eq("id", caller.accountId).maybeSingle();
    const { data: asst } = await supabase.from("assistants").select("twilio_number").eq("account_id", caller.accountId).limit(1).maybeSingle();
    const { data: me } = await supabase.from("users").select("full_name").eq("id", caller.userId).maybeSingle();
    if (action === "test_call") {
      const donnaNum = (asst as any)?.twilio_number; if (!donnaNum) return json({ ok: false, error: "needs_number", message: "Set up the phone number first." });
      // Same brain as a real inbound call: ask retell-inbound for this account's variables, then dial out from the account's own number.
      const vr = await fetch(`${SELF}/retell-inbound`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ call_inbound: { to_number: donnaNum, from_number: to } }) });
      const vj: any = await vr.json().catch(() => ({})); const vars = vj?.call_inbound?.dynamic_variables || {};
      const r = await fetch("https://api.retellai.com/v2/create-phone-call", { method: "POST", headers: rh(), body: JSON.stringify({ from_number: donnaNum, to_number: to, override_agent_id: RETELL_AGENT_ID, retell_llm_dynamic_variables: Object.assign({}, vars, { test_call: "yes" }), metadata: { kind: "test_call", account_id: caller.accountId } }) });
      const j: any = await r.json().catch(() => ({})); if (!j?.call_id) return json({ ok: false, error: "call_failed", detail: j });
      const settings: any = Object.assign({}, acct?.settings || {}); settings.onboarding = Object.assign({}, settings.onboarding || {}, { test_call_at: new Date().toISOString() }); await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
      return json({ ok: true, call_id: j.call_id, from: donnaNum });
    }
    // Setup by phone
    const sa = await ensureSetupAgent(); const from = await ensureOutboundNumber(); if (!sa || !from) return json({ ok: false, error: "no_outbound" });
    const s: any = acct?.settings || {}; const industry = acct?.industry || "other";
    const { data: types } = await supabase.from("appointment_types").select("name, price").eq("account_id", caller.accountId).eq("is_active", true).limit(12);
    const { data: rules } = await supabase.from("availability_rules").select("day_of_week").eq("user_id", caller.userId).eq("rule_type", "working");
    const known: any = { hours: !!(rules || []).length, services: !!(types || []).length, team: !!(s.onboarding?.team_found || []).length };
    const knownText = [acct?.name ? `business: ${acct.name}` : "", s.business?.address ? `address: ${s.business.address}` : "", known.hours ? "hours: already on file" : "", (types || []).length ? `services on file: ${(types || []).map((t: any) => t.name + (t.price ? " " + t.price : "")).join(", ")}` : ""].filter(Boolean).join("; ") || "nothing yet besides the business name";
    const questions = interviewQuestions(industry, known).map((q, i) => `${i + 1}. ${q}`).join(" ");
    const r = await fetch("https://api.retellai.com/v2/create-phone-call", { method: "POST", headers: rh(), body: JSON.stringify({ from_number: from, to_number: to, override_agent_id: sa.agent_id, retell_llm_dynamic_variables: { owner_name: String((me as any)?.full_name || "there").split(" ")[0], business_name: acct?.name || "your business", vertical_label: VERTICAL_LABEL[industry] || "a small business", known: knownText, questions }, metadata: { kind: "setup_interview", account_id: caller.accountId, user_id: caller.userId } }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.call_id) return json({ ok: false, error: "call_failed", detail: j });
    const settings: any = Object.assign({}, acct?.settings || {}); settings.onboarding = Object.assign({}, settings.onboarding || {}, { phone_setup_call_id: j.call_id, phone_setup_started_at: new Date().toISOString() }); await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
    return json({ ok: true, call_id: j.call_id, from });
  }

  if (action === "phone_setup_result") {
    const callId = String(body.call_id || ""); if (!callId) return json({ ok: false, error: "no_call" });
    const r = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, { headers: rh() }); const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return json({ ok: false, error: "get_call_failed" });
    const status = j.call_status || ""; if (status !== "ended" && status !== "error") return json({ ok: true, status, done: false });
    const transcript = String(j.transcript || "");
    if (transcript.replace(/\s/g, "").length < 80) return json({ ok: true, status, done: true, empty: true, message: "The call was too short to set anything up." });
    const ext = await llmJson(EXTRACT_CALL_SYSTEM, `Transcript:\n${transcript.slice(0, 30000)}\n\nReturn the JSON now.`);
    if (!ext) return json({ ok: false, error: "extract_failed" });
    const proposal: any = { services: (ext.services || []).map((s: any) => ({ ...s, keep: true })), team: (ext.team || []).map((t: any) => ({ ...t, keep: true })), faq: [] as any[] };
    if (ext.hours && Array.isArray(ext.hours.days)) proposal.hours = { days: ext.hours.days, open: ext.hours.open || "09:00", close: ext.hours.close || "17:00", per_day: {} };
    if (ext.transfer?.mode === "cell" && ext.transfer?.number) proposal.transfer_number = ext.transfer.number;
    if (ext.service_area) proposal.service_area = ext.service_area;
    const pol = [ext.after_hours ? `After hours: ${ext.after_hours}` : "", ext.trip_fee ? `Trip fee: ${ext.trip_fee}` : "", ext.always_say ? `Always tell callers: ${ext.always_say}` : "", ext.never_say ? `Never say: ${ext.never_say}` : "", ext.notes || ""].filter(Boolean).join(" ");
    if (pol) proposal.policies = pol;
    let applied: any = null;
    if (body.apply) {
      // Merge onto what is already there: keep the business block from the account.
      const { data: acct } = await supabase.from("accounts").select("name, industry, settings").eq("id", caller.accountId).maybeSingle(); const s: any = acct?.settings || {};
      applied = await applyProposal(caller, Object.assign({ business: { name: acct?.name, phone: s.business?.phone, address: s.business?.address, website: s.business?.website, tz: s.timezone }, industry: acct?.industry }, proposal));
      const { data: fresh } = await supabase.from("accounts").select("settings").eq("id", caller.accountId).maybeSingle(); const settings: any = Object.assign({}, fresh?.settings || {}); settings.onboarding = Object.assign({}, settings.onboarding || {}, { phone_setup_done_at: new Date().toISOString(), phone_setup_summary: ext.summary_for_owner || "" }); await supabase.from("accounts").update({ settings }).eq("id", caller.accountId);
    }
    return json({ ok: true, status, done: true, proposal, summary: ext.summary_for_owner || "", applied });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
