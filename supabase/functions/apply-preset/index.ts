import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna industry presets. Applies a vertical's shared content layer to an
// account: assistant persona defaults, default appointment/service types, a
// starter FAQ pack seeded as UNAPPROVED drafts, and (for salons) the word the
// business uses for the people who take appointments (provider_label).
// Idempotent per industry.
// v7: every other industry (restaurant, contractor, real estate, professional, other, or
// anything unknown) gets the GENERAL preset: a plain small-business persona and a starter FAQ
// pack, so no owner starts from an empty Knowledge page. No appointment types are invented for
// them; the owner's own list (from setup) stands.
// v11: real_estate preset points Donna at the listing lookup / showing / application tools instead of
// telling her to only answer from the knowledge base (which fought the Real Estate pack).
//
// Auth mirrors provision-email: verify_jwt off, self-authenticating. A tenant
// calls with their user JWT and can only apply to their own account. A service
// call carries the service-role key and may pass account_id + industry + dry_run.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", ...CORS } });

type Preset = {
  opening_question: string;
  instructions: string;
  appointment_types: { name: string; mode: string; dur: number }[];
  faq: { title: string; content: string }[];
  features: Record<string, boolean>;
  provider_label?: string;
  faq_title?: string;
};

const DRAFT = "DRAFT - replace the bracketed parts with your real details, then approve this so Donna can use it.\n\n";

function salonFaq(label: string): { title: string; content: string }[] {
  return [
    { title: "What are your hours?", content: DRAFT + "We are open [days and hours]. Donna can take booking requests any time." },
    { title: `How do I book with a specific ${label}?`, content: DRAFT + `Just let us know who you would like to see. [${label} names and what they specialize in].` },
    { title: "What is your cancellation policy?", content: DRAFT + "Please give us at least [number] hours notice to cancel or reschedule. [Late cancel / no-show fee, if any]." },
    { title: "Do you require a deposit?", content: DRAFT + "[We require a deposit of (amount) to hold (which services) / We do not require a deposit]. [How it is applied]." },
    { title: "Do you take walk-ins?", content: DRAFT + `[We welcome walk-ins when a ${label} is open / We are by appointment only]. Booking ahead is the best way to get your preferred time.` },
    { title: "How much is a [service]?", content: DRAFT + "[Service]: starts at [price]. Final pricing depends on [length / detail / provider level]." },
    { title: "What services do you offer?", content: DRAFT + "We offer [list your main services]. [Any specialties]." },
    { title: "Where are you located and is there parking?", content: DRAFT + "We are at [address]. Parking is [street / lot / garage]." },
  ];
}

function salonPreset(typeNoun: string, label: string, services: { name: string; mode: string; dur: number }[], askAllergies: boolean): Preset {
  const instr = [
    `You are answering for a ${typeNoun}. Most callers want to book, reschedule, or cancel an appointment, or ask about services and pricing.`,
    `When booking, find out which service they want and, if they know, roughly how long it takes. Ask whether they have a preferred ${label} or are happy with whoever is available.`,
    "Ask whether they are a new or returning client. For a returning client, use what you remember about them, including their usual provider and service.",
  ];
  if (askAllergies) instr.push("For any service involving chemicals, ask whether they have any allergies or sensitivities and note them.");
  instr.push(
    "Answer service, pricing, cancellation, and deposit questions only from the approved knowledge base. Never quote a price or policy that is not in it. If you are unsure, offer to take a message or have someone follow up.",
    "Be warm and friendly, the way a great front-desk person would be.",
  );
  return {
    opening_question: "Are you looking to book an appointment, or is there something else I can help you with?",
    instructions: instr.join(" "),
    appointment_types: services,
    faq: salonFaq(label),
    features: { salon: true },
    provider_label: label,
    faq_title: "Salon starter FAQ (draft)",
  };
}

const HAIR = salonPreset("hair salon", "stylist", [
  { name: "Haircut", mode: "in_person", dur: 45 },
  { name: "Haircut and style", mode: "in_person", dur: 60 },
  { name: "Color", mode: "in_person", dur: 120 },
  { name: "Highlights", mode: "in_person", dur: 180 },
  { name: "Blowout", mode: "in_person", dur: 45 },
], true);

// The everyday small business: a tutor, a detailer, a cleaner, an accountant, a photographer, a
// consultant. Donna answers, books, takes messages, and never guesses at prices or policies.
const GENERAL_FAQ = [
  { title: "What are your hours?", content: DRAFT + "We are open [days and hours]. Donna answers the phone any time and can book or take a message outside those hours." },
  { title: "Where are you located? Do you come to me?", content: DRAFT + "[We are at (address) / We come to you anywhere in (service area)]. [Parking or access notes]." },
  { title: "What do you offer and what does it cost?", content: DRAFT + "[Service 1]: [price or starting price]. [Service 2]: [price]. [Anything that changes the price, e.g. size, travel, materials]." },
  { title: "How do I book?", content: DRAFT + "Call us any time and Donna will find a time, or book online at [your booking link]. [Anything you need from the customer first, e.g. address, vehicle, photos]." },
  { title: "How do I pay?", content: DRAFT + "We take [cash / card / Zelle / Venmo / check]. [Deposit, if any]. [When payment is due]." },
  { title: "What is your cancellation policy?", content: DRAFT + "Please give us [number] hours notice to cancel or reschedule. [Late cancellation fee, if any]." },
  { title: "Are you licensed and insured?", content: DRAFT + "[Yes - license number / insurance details, or remove this question if it does not apply]." },
  { title: "Do you offer free estimates or a first consultation?", content: DRAFT + "[Yes, estimates are free / A consultation is (price) and is applied to the job]. [How to get one]." },
  { title: "What should I have ready for my appointment?", content: DRAFT + "[Anything the customer should prepare, e.g. clear the driveway, have documents ready, nothing at all]." },
];
function generalPreset(noun: string, extra: string[], opening = "How can I help you today?"): Preset {
  return {
    opening_question: opening,
    instructions: [
      `You are answering for ${noun}. Most callers want to book a time, ask what it costs or how it works, or reach the owner.`,
      "When someone wants to book, find out what they need done, any details that affect it (where, how big, how many), and when works for them, then offer the open times.",
      "Answer price, policy, and availability questions only from the approved knowledge base. If the answer is not there, say you will have someone follow up and take a clear message with the best callback number.",
      ...extra,
      "Be friendly and plain-spoken. Short answers. Confirm names, numbers, and addresses by reading them back.",
    ].join(" "),
    appointment_types: [],
    faq: GENERAL_FAQ,
    features: {},
    faq_title: "Starter FAQ (draft) - fill in your details",
  };
}
const GENERAL = generalPreset("a small local business", []);

const PRESETS: Record<string, Preset> = {
  property_management: {
    opening_question: "Are you calling about a maintenance issue, a leasing or application question, or something else?",
    instructions: [
      "You are answering for a property management company. Callers are usually current residents, prospective tenants, or vendors.",
      "Find out early whether the caller is a current resident or a prospective tenant. For current residents, ask for the property address and unit number.",
      "Maintenance: gather a clear description of the problem, the unit, and the best callback number, then take it as a message.",
      "Emergencies (burst pipe, flooding, no heat or air in extreme weather, gas smell, fire, or a lockout) are urgent. If a transfer number is set, offer to connect the caller right away. If no one answers or no transfer is set, take full details and mark the message as an emergency so the on-call person is alerted immediately.",
      "Leasing: answer availability and application questions from approved knowledge only, and offer to book a showing.",
      "Never quote rent, fees, policies, or availability unless it is in the approved knowledge base. If you are unsure, take a message instead of guessing.",
    ].join(" "),
    appointment_types: [
      { name: "Property showing", mode: "in_person", dur: 30 },
      { name: "Maintenance walkthrough", mode: "in_person", dur: 30 },
      { name: "Leasing consultation", mode: "phone", dur: 30 },
    ],
    faq: [
      { title: "How do I submit a maintenance request?", content: DRAFT + "You can submit a maintenance request by [phone / online portal / email]. For after-hours emergencies, call [emergency number]." },
      { title: "What are your office hours?", content: DRAFT + "Our office is open [days and hours]. Donna answers calls any time." },
      { title: "How do I pay rent?", content: DRAFT + "Rent is due on the [Nth] of each month and can be paid by [portal / check / auto-pay]. A late fee of [amount] applies after [grace period]." },
      { title: "What is your pet policy?", content: DRAFT + "Our pet policy is [allowed / not allowed]. If allowed: [deposit / monthly pet rent / breed or weight limits]." },
      { title: "How do I apply for a unit?", content: DRAFT + "Apply at [application link or process]. The application fee is [amount] and we require [income / credit / background requirements]." },
      { title: "Who do I contact for an after-hours emergency?", content: DRAFT + "For a true emergency after hours, call [emergency number]. Donna can also take the details and alert the on-call manager right away." },
      { title: "How do I give notice to move out?", content: DRAFT + "Provide written notice [number] days before your move-out date by [method]. A move-out inspection will be scheduled." },
      { title: "Where is the property located and is parking available?", content: DRAFT + "The property is at [address]. Parking is [assigned / street / garage], and [guest parking details]." },
    ],
    features: { property_management: true, after_hours_emergency: true },
    faq_title: "Property management starter FAQ (draft)",
  },

  salon: HAIR,
  hair_salon: HAIR,
  nail_salon: salonPreset("nail salon", "technician", [
    { name: "Manicure", mode: "in_person", dur: 30 },
    { name: "Pedicure", mode: "in_person", dur: 45 },
    { name: "Gel manicure", mode: "in_person", dur: 45 },
    { name: "Dip powder", mode: "in_person", dur: 60 },
    { name: "Full set", mode: "in_person", dur: 75 },
  ], true),
  barbershop: salonPreset("barbershop", "barber", [
    { name: "Haircut", mode: "in_person", dur: 30 },
    { name: "Beard trim", mode: "in_person", dur: 20 },
    { name: "Haircut and beard", mode: "in_person", dur: 45 },
    { name: "Hot towel shave", mode: "in_person", dur: 30 },
    { name: "Kids cut", mode: "in_person", dur: 20 },
  ], false),
  spa: salonPreset("spa", "therapist", [
    { name: "Facial", mode: "in_person", dur: 60 },
    { name: "Massage", mode: "in_person", dur: 60 },
    { name: "Waxing", mode: "in_person", dur: 30 },
    { name: "Body treatment", mode: "in_person", dur: 90 },
  ], true),
  lash_brow: salonPreset("lash and brow studio", "artist", [
    { name: "Lash fill", mode: "in_person", dur: 60 },
    { name: "Lash full set", mode: "in_person", dur: 120 },
    { name: "Brow lamination", mode: "in_person", dur: 45 },
    { name: "Brow wax and tint", mode: "in_person", dur: 30 },
  ], false),

  restaurant: generalPreset("a restaurant", [
    "Callers usually want a reservation, hours, the menu, or takeout. Take reservations as bookings (party size, name, time). Do not take food orders over the phone unless the knowledge base says to; offer the ordering link or a callback instead.",
  ]),
  contractor: generalPreset("a contractor", [
    "Callers usually want an estimate or have a problem to fix. Get the job address, what is wrong or wanted, and photos if they can text them. Urgent problems (active leak, no power, no heat, safety issue) should be offered a transfer when one is set, otherwise taken as an urgent message.",
  ]),
  real_estate: generalPreset("a real estate agent", [
    "Callers are usually buyers, sellers, or renters. Find out which, the area, and what they are looking for. Use the listing lookup to answer questions about our listings and never quote a price, availability, or detail you did not get from it. Offer to book a showing or a consultation with the agent, and send the application or showing agreement when they are ready.",
  ], "Are you calling about a home for sale, a rental, or about selling your home?"),
  professional: generalPreset("a professional services firm", [
    "Callers usually want a consultation or have a question about an existing matter. Offer a consultation booking and take a clear message for anything about existing work; do not give advice.",
  ]),
  other: GENERAL,
};

const PRESET_MARKER = (industry: string) => `[[preset:${industry}]]`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const isService = token && token === SERVICE_ROLE_KEY;
  const dryRun = isService && body?.dry_run === true;

  let accountId: string | null = null;
  if (isService) {
    accountId = body?.account_id || null;
    if (!accountId) return json({ ok: false, reason: "account_id_required_for_service_call" }, 400);
  } else {
    if (!token) return json({ ok: false, reason: "unauthorized" }, 401);
    const { data: u, error: ue } = await supabase.auth.getUser(token);
    if (ue || !u?.user) return json({ ok: false, reason: "unauthorized" }, 401);
    const { data: me } = await supabase.from("users").select("account_id").eq("id", u.user.id).maybeSingle();
    if (!me?.account_id) return json({ ok: false, reason: "no_account" }, 403);
    accountId = me.account_id;
  }

  const { data: acct } = await supabase.from("accounts").select("id, industry, settings").eq("id", accountId).maybeSingle();
  if (!acct) return json({ ok: false, reason: "account_not_found" }, 404);

  const rawIndustry = String(body?.industry || acct.industry || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const industry = PRESETS[rawIndustry] ? rawIndustry : "other";   // unknown industries fall back to the general preset
  const preset = PRESETS[industry];

  const settings = (acct.settings && typeof acct.settings === "object") ? acct.settings : {};
  if (settings.preset_applied === industry && !dryRun) {
    return json({ ok: true, applied: false, already: true, industry });
  }

  const { data: asst } = await supabase.from("assistants").select("id, routing").eq("account_id", accountId).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const { count: typeCount } = await supabase.from("appointment_types").select("*", { count: "exact", head: true }).eq("account_id", accountId);
  const routing = (asst?.routing && typeof asst.routing === "object") ? { ...asst.routing } : {};
  const willSetOpening = !String(routing.opening_question || "").trim();
  const existingInstr = String(routing.custom_instructions || "");
  const willAppendInstr = !existingInstr.includes(PRESET_MARKER(industry));
  const willAddTypes = (typeCount || 0) === 0 && preset.appointment_types.length > 0;

  const plan = {
    industry,
    set_opening_question: willSetOpening,
    append_instructions: willAppendInstr,
    add_appointment_types: willAddTypes ? preset.appointment_types.map((t) => t.name) : [],
    faq_drafts: preset.faq.length,
    features: preset.features,
    provider_label: preset.provider_label || null,
  };

  if (dryRun) return json({ ok: true, applied: false, dry_run: true, plan });

  if (asst?.id) {
    if (willSetOpening) routing.opening_question = preset.opening_question;
    if (willAppendInstr) {
      routing.custom_instructions = (existingInstr ? existingInstr.trim() + "\n\n" : "") + PRESET_MARKER(industry) + "\n" + preset.instructions;
    }
    if (willSetOpening || willAppendInstr) {
      await supabase.from("assistants").update({ routing }).eq("id", asst.id);
    }
  }

  if (willAddTypes) {
    const rows = preset.appointment_types.map((t) => ({
      account_id: accountId, name: t.name, mode: t.mode,
      default_duration_min: t.dur, buffer_before_min: 0, buffer_after_min: 0, requires_travel: false,
    }));
    await supabase.from("appointment_types").insert(rows);
  }

  let faqDocId: string | null = null;
  if (preset.faq.length) {
    const titleLabel = preset.faq_title || "Starter FAQ (draft)";
    const { data: doc } = await supabase.from("documents").insert({
      account_id: accountId, filename: titleLabel, doc_type: "other",
    }).select("id").maybeSingle();
    faqDocId = doc?.id ?? null;
    if (faqDocId) {
      const entries = preset.faq.map((f) => ({
        account_id: accountId, source: "document", category: "FAQ",
        title: f.title, content: f.content, document_id: faqDocId, approved: false,
      }));
      await supabase.from("knowledge_entries").insert(entries);
    }
  }

  const { data: fresh } = await supabase.from("accounts").select("settings").eq("id", accountId).maybeSingle();
  const base = (fresh?.settings && typeof fresh.settings === "object") ? fresh.settings : settings;
  const newSettings: Record<string, unknown> = { ...base, preset_applied: industry, features: { ...(base.features || {}), ...preset.features } };
  if (preset.provider_label) newSettings.provider_label = preset.provider_label;
  await supabase.from("accounts").update({ settings: newSettings }).eq("id", accountId);

  return json({ ok: true, applied: true, industry, plan, faq_document_id: faqDocId });
});
