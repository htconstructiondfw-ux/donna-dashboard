import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// Donna real estate — signing module (v1). Donna's own e-sign for the agent's OWN documents
// (showing agreement, intake sheets, rental application). ESIGN/UETA pattern: consent to do business
// electronically, one-time code to the signer's phone, intent-to-sign action, flattened PDF with the
// signature image, SHA-256 of the final file, audit certificate page, immutable copy in private storage.
// Not for TREC promulgated contracts — those still go through the broker's transaction system.
//
// User actions (JWT, or service role + user_id, or service role + account_id for internal callers):
//   doc_send {kind, lead_id?, listing_id?, appointment_id?, signer_name, signer_phone, signer_email?, fields?}
//   doc_resend {id} | doc_void {id} | doc_url {id, which: pdf|certificate} | send_iabs {lead_id | phone, name?}
//   signed_for {phone, listing_id?}  -> is there a signed showing agreement for this phone (internal use)
// Public (token): view | otp_send | otp_verify {code} | consent | sign {signature_png, typed_name, form?} | decline {reason} | fee_link | signed_url

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const BUCKET = "re-documents";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signUrl = (t: string) => `${APP}/sign/${t}`;
const now = () => new Date().toISOString();
const fmtWhen = (iso: string, tz: string) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz || "America/Chicago", dateStyle: "long", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; } };
const normPhone = (p: string) => { const d = String(p || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d.startsWith("1")) return "+" + d; return String(p || "").trim(); };
const KIND_TITLES: Record<string, string> = { showing_agreement: "Showing Agreement", buyer_intake: "Buyer Information Sheet", seller_intake: "Seller Information Sheet", landlord_intake: "Owner / Landlord Information Sheet", rental_application: "Rental Application", consent: "Consent", custom: "Document" };

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  try {
    const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to, body }) });
    const j: any = await r.json().catch(() => ({})); if (!j?.ok) return false;
    try { const { data: cv } = await supabase.from("conversations").upsert({ account_id: accountId, channel: "sms", customer_identifier: to, last_outbound_at: now(), updated_at: now() }, { onConflict: "account_id,channel,customer_identifier" }).select("id").maybeSingle(); if (cv?.id) await supabase.from("conversation_messages").insert({ account_id: accountId, conversation_id: cv.id, direction: "outbound", actor: "donna", channel: "sms", body, status: "sent" }); } catch { /* ok */ }
    return true;
  } catch { return false; }
}
async function sendEmail(to: string, from: string, subject: string, text: string, attachment?: { filename: string; content: string }): Promise<boolean> {
  if (!RESEND_KEY || !to) return false;
  try { const payload: any = { from, to: [to], subject, text }; if (attachment) payload.attachments = [attachment]; const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; }
}
async function loadAccount(id: string) { const { data } = await supabase.from("accounts").select("id, name, settings").eq("id", id).maybeSingle(); return data as any; }
async function agentPhones(accountId: string, agentUserId: string | null): Promise<string[]> {
  const out = new Set<string>();
  if (agentUserId) { const { data } = await supabase.from("users").select("phone").eq("id", agentUserId).maybeSingle(); if ((data as any)?.phone) out.add((data as any).phone); }
  if (!out.size) { const { data: o } = await supabase.from("users").select("phone").eq("account_id", accountId).eq("role", "owner").not("phone", "is", null).limit(1).maybeSingle(); if ((o as any)?.phone) out.add((o as any).phone); }
  return [...out];
}
async function resolveCaller(req: Request, body: any) {
  const m = (req.headers.get("Authorization") || "").match(/Bearer\s+(.+)/i); if (!m) return null;
  if (m[1] === SERVICE_ROLE) {
    if (body?.user_id) { const { data: me } = await supabase.from("users").select("id, account_id, role, full_name").eq("id", body.user_id).maybeSingle(); return me ? { userId: me.id, accountId: me.account_id, role: me.role, name: me.full_name } : null; }
    if (body?.account_id) return { userId: null as string | null, accountId: String(body.account_id), role: "system", name: "Donna" };
    return null;
  }
  const userClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });
  const { data: { user } } = await userClient.auth.getUser(m[1]); if (!user) return null;
  const { data: me } = await supabase.from("users").select("account_id, role, full_name").eq("id", user.id).maybeSingle(); if (!(me as any)?.account_id) return null;
  return { userId: user.id as string | null, accountId: (me as any).account_id, role: (me as any).role, name: (me as any).full_name };
}
function clientMeta(req: Request) { return { ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "", ua: (req.headers.get("user-agent") || "").slice(0, 200) }; }
async function audit(doc: any, event: string, req: Request, detail?: any) {
  const entry = { at: now(), event, ...clientMeta(req), ...(detail ? { detail } : {}) };
  const list = Array.isArray(doc.audit) ? doc.audit : [];
  list.push(entry); doc.audit = list;
  return list;
}

// ---------- templates ----------
const DEFAULT_SHOWING = `SHOWING AGREEMENT

I, {{signer_name}}, ask {{agent_name}} ({{company}}) to show me the property at {{property_address}} on or about {{showing_date}}.

I understand that:
1. {{agent_name}} is a licensed Texas real estate agent sponsored by {{broker_name}}, and has given me the Texas Real Estate Commission's Information About Brokerage Services notice.
2. This is a showing only. It does not make {{agent_name}} my agent and does not obligate me to buy, lease or pay anything.
3. I will be respectful of the property and follow the agent's instructions while inside.
4. I may be asked to show a government-issued photo ID before entering.

Signed electronically. A copy of this agreement and its signing record is texted or emailed to me.`;
const INTAKE_BODIES: Record<string, string> = {
  buyer_intake: `BUYER INFORMATION SHEET\n\nThis sheet helps {{agent_name}} with {{company}} understand what you're looking for. It is not a contract and does not create an agency relationship.\n\nPlease review the answers below, correct anything that's off, and sign to confirm they're accurate.`,
  seller_intake: `SELLER INFORMATION SHEET\n\nThis sheet gives {{agent_name}} with {{company}} the basics about the property you're thinking of selling. It is not a listing agreement and does not obligate you to list.\n\nPlease review the answers below, correct anything that's off, and sign to confirm they're accurate.`,
  landlord_intake: `OWNER / LANDLORD INFORMATION SHEET\n\nThis sheet gives {{agent_name}} with {{company}} the basics about the property you'd like to rent out. It is not a management or listing agreement.\n\nPlease review the answers below, correct anything that's off, and sign to confirm they're accurate.`,
  rental_application: `RENTAL APPLICATION\n\nProperty: {{property_address}}\nApplying through: {{agent_name}}, {{company}}{{fee_line}}\n\nBy signing, I confirm that the information I've given is true and complete, and I authorize {{company}} and the property owner to verify it, including contacting my employer and current and previous landlords and running the screening the owner requires. I understand this application does not guarantee approval, and that submitting it does not reserve the property.\n\nFair housing: applications are reviewed under the same written criteria for everyone, regardless of race, color, religion, sex, national origin, familial status or disability.`,
  consent: `CONSENT\n\n{{consent_text}}`,
  custom: `{{body}}`,
};
// Form fields the signer fills before signing (rental application). Donna never asks for SSN or ID numbers in a text link;
// the owner's screening vendor collects those under its own consent.
const APPLICATION_FORM = [
  { id: "full_name", label: "Full legal name", type: "text", req: true }, { id: "phone", label: "Mobile", type: "tel", req: true }, { id: "email", label: "Email", type: "email", req: true },
  { id: "move_in", label: "Desired move-in date", type: "date", req: true }, { id: "lease_months", label: "Lease length wanted", type: "select", options: ["12 months", "18 months", "24 months", "6 months", "Other"], req: true },
  { id: "occupants", label: "Everyone who will live there (names and ages of minors)", type: "textarea", req: true },
  { id: "pets", label: "Pets (type, breed, weight) or 'none'", type: "text", req: true },
  { id: "current_address", label: "Current address", type: "text", req: true }, { id: "current_since", label: "There since (month/year)", type: "text", req: true }, { id: "current_rent", label: "Current rent / mortgage per month", type: "text" },
  { id: "current_landlord", label: "Current landlord or manager (name and phone)", type: "text", req: true }, { id: "reason_moving", label: "Reason for moving", type: "text" },
  { id: "employer", label: "Employer", type: "text", req: true }, { id: "position", label: "Position", type: "text", req: true }, { id: "employed_since", label: "There since (month/year)", type: "text", req: true },
  { id: "monthly_income", label: "Gross monthly income (all sources)", type: "text", req: true }, { id: "other_income", label: "Other income you'd like considered", type: "text" },
  { id: "vehicles", label: "Vehicles (year, make, plate) or 'none'", type: "text" },
  { id: "evicted", label: "Have you ever been evicted or broken a lease?", type: "select", options: ["No", "Yes — I'll explain below"], req: true },
  { id: "notes", label: "Anything else the owner should know", type: "textarea" },
  { id: "emergency_contact", label: "Emergency contact (name, relationship, phone)", type: "text", req: true },
];
const INTAKE_FORMS: Record<string, any[]> = {
  buyer_intake: [{ id: "areas", label: "Areas you're considering", type: "text" }, { id: "price_range", label: "Price range", type: "text" }, { id: "beds_baths", label: "Bedrooms / bathrooms wanted", type: "text" }, { id: "must_haves", label: "Must-haves", type: "textarea" }, { id: "timeline", label: "When do you want to move?", type: "text" }, { id: "preapproved", label: "Pre-approved with a lender?", type: "select", options: ["Yes", "Not yet", "Paying cash"] }, { id: "lender", label: "Lender (if any)", type: "text" }, { id: "selling_first", label: "Do you need to sell a home first?", type: "select", options: ["No", "Yes"] }, { id: "has_agent", label: "Are you already working with another agent?", type: "select", options: ["No", "Yes"] }],
  seller_intake: [{ id: "property_address", label: "Property address", type: "text", req: true }, { id: "property_type", label: "Type (home, condo, land, commercial…)", type: "text" }, { id: "beds_baths_sqft", label: "Beds / baths / square feet", type: "text" }, { id: "occupancy", label: "Who lives there now?", type: "select", options: ["Me / owner", "Tenant", "Vacant"] }, { id: "timeline", label: "When would you like it sold?", type: "text" }, { id: "price_idea", label: "Price you have in mind (optional)", type: "text" }, { id: "mortgage", label: "Is there a mortgage? Roughly how much is owed? (optional)", type: "text" }, { id: "repairs", label: "Known repairs or updates", type: "textarea" }, { id: "has_agent", label: "Currently listed or under agreement with another agent?", type: "select", options: ["No", "Yes"] }],
  landlord_intake: [{ id: "property_address", label: "Property address", type: "text", req: true }, { id: "beds_baths_sqft", label: "Beds / baths / square feet", type: "text" }, { id: "rent_idea", label: "Rent you have in mind", type: "text" }, { id: "available", label: "Available from", type: "date" }, { id: "occupancy", label: "Who's there now?", type: "select", options: ["Vacant", "Tenant moving out", "Me / owner"] }, { id: "pets", label: "Pet policy", type: "select", options: ["No pets", "Cats", "Dogs", "Cats & dogs", "Case by case"] }, { id: "management", label: "Do you want ongoing management, or just placement?", type: "select", options: ["Placement only", "Full management", "Not sure"] }, { id: "notes", label: "Anything else", type: "textarea" }],
};
function fill(tpl: string, fields: Record<string, any>) { return String(tpl || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => (fields[k] ?? fields[k.toLowerCase()] ?? "").toString()); }

async function buildDoc(acct: any, kind: string, body: any, listing: any, caller: any) {
  const s = acct.settings?.real_estate || {};
  const agentName = String(body.agent_name || caller?.name || s.agent_name || acct.name || "").trim() || acct.name;
  const feeCents = kind === "rental_application" ? Number(s.application_fee_cents || 0) : 0;
  const fields: Record<string, any> = Object.assign({
    signer_name: String(body.signer_name || "").trim(), agent_name: agentName, company: acct.name, broker_name: s.broker_name || acct.name, license_no: s.license_no || "",
    property_address: listing ? [listing.address, listing.city, listing.state, listing.zip].filter(Boolean).join(", ") : (body.property_address || ""),
    showing_date: body.showing_date || "the agreed time", fee_line: feeCents > 0 ? `\nApplication fee: ${money(feeCents)} (non-refundable, paid by card after signing)` : "", consent_text: body.consent_text || "", body: body.body || "",
  }, body.fields || {});
  const tpl = kind === "showing_agreement" ? (s.showing_agreement_text || DEFAULT_SHOWING) : (INTAKE_BODIES[kind] || INTAKE_BODIES.custom);
  const title = String(body.title || KIND_TITLES[kind] || "Document");
  const formSchema = kind === "rental_application" ? APPLICATION_FORM : (INTAKE_FORMS[kind] || null);
  return { title, body_md: fill(tpl, fields), fields, form: formSchema ? { schema: formSchema, answers: body.answers || {} } : null, fee_cents: feeCents };
}

// ---------- PDF ----------
function wrap(font: any, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    if (!para.trim()) { out.push(""); continue; }
    let line = "";
    for (const w of para.split(/\s+/)) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= width) line = t; else { if (line) out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  return out;
}
const clean = (s: string) => String(s ?? "").replace(/[^\x09\x0A\x20-\x7E -ÿ]/g, (c) => ({ "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "•": "-", "…": "..." } as any)[c] || "?");
async function renderPdf(doc: any, acct: any, sigPng: string | null, typedName: string, audit: any[], tz: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, size = 10.5, lh = 15;
  let page = pdf.addPage([W, H]); let y = H - M;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const text = (t: string, opts: { bold?: boolean; size?: number; color?: any; x?: number } = {}) => {
    const f = opts.bold ? bold : font, sz = opts.size || size;
    for (const ln of wrap(f, clean(t), sz, W - 2 * M - (opts.x || 0))) { if (y < M + 40) newPage(); page.drawText(ln, { x: M + (opts.x || 0), y, size: sz, font: f, color: opts.color || rgb(0.1, 0.12, 0.11) }); y -= sz + 4.5; }
  };
  const gap = (n = 1) => { y -= lh * n * 0.6; };
  // Header
  page.drawText(clean(acct.name), { x: M, y, size: 16, font: bold, color: rgb(0.12, 0.43, 0.29) }); y -= 20;
  const s = acct.settings?.real_estate || {};
  text([s.broker_name ? `Sponsoring broker: ${s.broker_name}` : "", s.license_no ? `License #${s.license_no}` : "", acct.settings?.business?.phone || ""].filter(Boolean).join("  ·  "), { size: 9, color: rgb(0.45, 0.5, 0.47) });
  gap(1.2);
  text(doc.title, { bold: true, size: 14 }); gap(0.8);
  const bodyLines = String(doc.body_md || "").split("\n");
  // First line that matches the title in caps is skipped (the template often repeats it).
  const skipFirst = bodyLines[0] && bodyLines[0].trim().toUpperCase() === bodyLines[0].trim() && bodyLines[0].trim().length > 3;
  text((skipFirst ? bodyLines.slice(1) : bodyLines).join("\n").trim());
  // Form answers
  const form = doc.form; const answers = (form && form.answers) || {};
  if (form && form.schema && Object.keys(answers).length) {
    gap(1.4); text(doc.kind === "rental_application" ? "Application details" : "Your answers", { bold: true, size: 12 }); gap(0.5);
    for (const f of form.schema) { const v = answers[f.id]; if (v == null || v === "") continue; text(f.label, { size: 9, color: rgb(0.45, 0.5, 0.47) }); text(String(v)); y -= 3; }
  }
  if (doc.listing) { gap(1.2); text("Property", { bold: true, size: 12 }); gap(0.4); text(`${doc.listing.address}${doc.listing.city ? ", " + doc.listing.city : ""}${doc.listing.zip ? " " + doc.listing.zip : ""}${doc.listing.price_cents ? " — " + money(doc.listing.price_cents) + (doc.kind === "rental_application" ? "/mo" : "") : ""}`); }
  // Signature block
  gap(2); if (y < M + 150) newPage();
  text("Signed by", { bold: true, size: 12 }); gap(0.5);
  if (sigPng) { try { const png = await pdf.embedPng(sigPng); const dims = png.scale(Math.min(1, 220 / png.width)); page.drawImage(png, { x: M, y: y - dims.height + 6, width: dims.width, height: dims.height }); y -= dims.height + 2; } catch { /* no image */ } }
  else if (typedName) { page.drawText(clean(typedName), { x: M, y: y - 18, size: 22, font, color: rgb(0.1, 0.12, 0.3) }); y -= 28; }
  page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) }); y -= 13;
  text(`${doc.signer_name || typedName}${doc.signer_phone ? "  ·  " + doc.signer_phone : ""}${doc.signer_email ? "  ·  " + doc.signer_email : ""}`, { size: 9.5 });
  text(`Signed electronically ${fmtWhen(doc.signed_at || now(), tz)} (${tz})`, { size: 9.5, color: rgb(0.45, 0.5, 0.47) });
  text(`Document ID ${doc.id}`, { size: 8.5, color: rgb(0.45, 0.5, 0.47) });
  // Certificate page
  newPage();
  page.drawText("Signing Certificate", { x: M, y, size: 16, font: bold, color: rgb(0.12, 0.43, 0.29) }); y -= 22;
  text(`This certificate is part of the document "${doc.title}" (ID ${doc.id}) sent by ${acct.name} through Donna. It records how the document was delivered, verified and signed. The SHA-256 fingerprint of the final file is written on the file's record.`, { size: 9.5 }); gap(1.2);
  const rows: [string, string][] = [["Signer", `${doc.signer_name || typedName}`], ["Phone verified", doc.signer_phone ? `${doc.signer_phone} (one-time code)` : "—"], ["Email", doc.signer_email || "—"], ["Sent", fmtWhen(doc.sent_at, tz)], ["Opened", doc.viewed_at ? fmtWhen(doc.viewed_at, tz) : "—"], ["Consented to e-sign", doc.consented_at ? fmtWhen(doc.consented_at, tz) : "—"], ["Identity verified", doc.verified_at ? fmtWhen(doc.verified_at, tz) : "—"], ["Signed", fmtWhen(doc.signed_at || now(), tz)], ["Signature method", sigPng ? "Drawn on screen" : "Typed name"], ["Time zone", tz]];
  for (const [k, v] of rows) { page.drawText(clean(k), { x: M, y, size: 9.5, font: bold }); text(v, { size: 9.5, x: 150 }); }
  gap(1.2); text("Event log", { bold: true, size: 12 }); gap(0.4);
  for (const e of audit) text(`${fmtWhen(e.at, tz)}  ${String(e.event).padEnd(22)}  ${e.ip ? "IP " + e.ip : ""}${e.detail ? "  " + (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 90) : ""}${e.ua ? "\n      " + e.ua.slice(0, 110) : ""}`, { size: 8.5 });
  gap(1); text("Electronic signatures on this document are intended to be legally binding under the U.S. ESIGN Act and the Texas Uniform Electronic Transactions Act. The signer consented to transact electronically, verified control of the phone number above with a one-time code, and completed a deliberate signing action.", { size: 8.5, color: rgb(0.45, 0.5, 0.47) });
  return await pdf.save();
}

async function loadDocByToken(token: string) { const { data } = await supabase.from("re_documents").select("*, re_listings(address, city, state, zip, price_cents, listing_type)").eq("token", token).maybeSingle(); if (data) (data as any).listing = (data as any).re_listings; return data as any; }
function publicView(d: any, acct: any) {
  const s = acct.settings?.real_estate || {};
  const fee = d.kind === "rental_application" ? Number(s.application_fee_cents || 0) : 0;
  return { id: d.id, kind: d.kind, title: d.title, body_md: d.body_md, fields: d.fields, form: d.form, status: d.status, signer_name: d.signer_name,
    signer_phone_masked: d.signer_phone ? "•••" + String(d.signer_phone).slice(-4) : null, expires_at: d.expires_at, signed_at: d.signed_at, consented: !!d.consented_at, verified: !!d.verified_at, pdf_ready: !!d.pdf_path,
    business: { name: acct.name, phone: acct.settings?.business?.phone || null, license: s.license_no || null, broker: s.broker_name || null, agent: d.fields?.agent_name || null },
    fee_cents: fee, fee_invoice: !!d.fee_invoice_id, listing: d.listing ? { address: d.listing.address, city: d.listing.city, zip: d.listing.zip, price_cents: d.listing.price_cents } : null };
}

async function notifyAgent(acct: any, d: any, msg: string) { for (const p of await agentPhones(acct.id, d.agent_user_id || d.created_by)) await sendText(acct.id, p, msg); }

async function createFeeInvoice(acct: any, d: any, feeCents: number): Promise<{ id: string; url: string } | null> {
  try {
    const { data: num } = await supabase.rpc("next_invoice_number", { p_account: acct.id });
    const row: any = { account_id: acct.id, contact_id: d.contact_id || null, number: num || `INV-${Date.now().toString().slice(-6)}`, status: "sent", lines: [{ desc: `Rental application fee${d.listing ? " — " + d.listing.address : ""}`, qty: 1, unit_cents: feeCents, cents: feeCents, kind: "service" }], customer_name: d.signer_name, customer_phone: d.signer_phone, customer_email: d.signer_email, service_address: d.listing ? d.listing.address : null, notes: "Non-refundable application fee. Paying it does not reserve the property.", sent_at: now(), created_by: d.created_by || null };
    const { data, error } = await supabase.from("invoices").insert(row).select("id, pay_token").maybeSingle();
    if (error || !data) { console.error("fee invoice", error?.message); return null; }
    return { id: data.id, url: `${APP}/pay/${data.pay_token}` };
  } catch (e) { console.error("fee invoice", e); return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: any = {}; try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }
  const action = String(body.action || "");

  // ================= Public (token) =================
  const PUBLIC = new Set(["view", "otp_send", "otp_verify", "consent", "sign", "decline", "fee_link", "signed_url", "save_form"]);
  if (PUBLIC.has(action)) {
    const token = String(body.token || "").trim(); if (!token) return json({ ok: false, error: "no_token" }, 400);
    const d = await loadDocByToken(token); if (!d) return json({ ok: false, error: "not_found" }, 404);
    const acct = await loadAccount(d.account_id); if (!acct) return json({ ok: false, error: "not_found" }, 404);
    const tz = acct.settings?.timezone || "America/Chicago";
    const expired = d.expires_at && new Date(d.expires_at).getTime() < Date.now() && ["sent", "viewed", "verified"].includes(d.status);
    if (expired) { await supabase.from("re_documents").update({ status: "expired", updated_at: now() }).eq("id", d.id); d.status = "expired"; }
    const save = async (patch: any) => { await supabase.from("re_documents").update({ ...patch, audit: d.audit, updated_at: now() }).eq("id", d.id); };

    if (action === "view") {
      if (d.status === "sent") { await audit(d, "opened", req); d.viewed_at = now(); d.status = "viewed"; await save({ status: "viewed", viewed_at: d.viewed_at }); }
      return json({ ok: true, doc: publicView(d, acct) });
    }
    if (["expired", "void", "declined"].includes(d.status)) return json({ ok: false, error: d.status, doc: publicView(d, acct) });
    if (action === "signed_url") {
      if (d.status !== "signed" || !d.pdf_path) return json({ ok: false, error: "not_signed" });
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(d.pdf_path, 3600); return json({ ok: true, url: data?.signedUrl || null });
    }
    if (action === "fee_link") {
      if (!d.fee_invoice_id) return json({ ok: false, error: "no_fee" });
      const { data: inv } = await supabase.from("invoices").select("pay_token, paid_at").eq("id", d.fee_invoice_id).maybeSingle();
      return json({ ok: true, url: inv ? `${APP}/pay/${inv.pay_token}` : null, paid: !!inv?.paid_at });
    }
    if (d.status === "signed") return json({ ok: false, error: "already_signed", doc: publicView(d, acct) });

    if (action === "consent") { if (!d.consented_at) { await audit(d, "consented", req, "Agreed to receive and sign electronically"); d.consented_at = now(); await save({ consented_at: d.consented_at }); } return json({ ok: true }); }
    if (action === "otp_send") {
      if (!d.signer_phone) return json({ ok: false, error: "no_phone", message: "There's no mobile number on this document. Please contact the agent." });
      if (d.otp_sent_at && Date.now() - new Date(d.otp_sent_at).getTime() < 45_000) return json({ ok: true, throttled: true });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const hash = await sha256Hex(`${d.token}:${code}`);
      const ok = await sendText(acct.id, d.signer_phone, `${acct.name}: your signing code is ${code}. It expires in 10 minutes. If you didn't request this, ignore it.`);
      if (!ok) return json({ ok: false, error: "sms_failed", message: "We couldn't text the code. Please try again in a moment." });
      await audit(d, "code_sent", req, `to •••${String(d.signer_phone).slice(-4)}`);
      await save({ otp_hash: hash, otp_sent_at: now(), otp_attempts: 0 });
      return json({ ok: true });
    }
    if (action === "otp_verify") {
      const code = String(body.code || "").replace(/\D/g, "");
      if (!d.otp_hash || !d.otp_sent_at) return json({ ok: false, error: "no_code", message: "Ask for a code first." });
      if (Date.now() - new Date(d.otp_sent_at).getTime() > 10 * 60_000) return json({ ok: false, error: "code_expired", message: "That code expired. Send a new one." });
      if ((d.otp_attempts || 0) >= 5) return json({ ok: false, error: "too_many", message: "Too many tries. Send a new code." });
      const good = (await sha256Hex(`${d.token}:${code}`)) === d.otp_hash;
      if (!good) { await supabase.from("re_documents").update({ otp_attempts: (d.otp_attempts || 0) + 1 }).eq("id", d.id); return json({ ok: false, error: "bad_code", message: "That code doesn't match." }); }
      await audit(d, "verified", req, `phone •••${String(d.signer_phone).slice(-4)} confirmed by one-time code`);
      d.verified_at = now(); d.status = "verified"; await save({ status: "verified", verified_at: d.verified_at, otp_hash: null });
      return json({ ok: true });
    }
    if (action === "save_form") {
      const answers = body.answers && typeof body.answers === "object" ? body.answers : {};
      const form = Object.assign({}, d.form || {}, { answers }); await supabase.from("re_documents").update({ form, updated_at: now() }).eq("id", d.id); return json({ ok: true });
    }
    if (action === "decline") {
      await audit(d, "declined", req, String(body.reason || "").slice(0, 200)); d.status = "declined"; await save({ status: "declined", declined_at: now() });
      await notifyAgent(acct, d, `${d.signer_name || "The signer"} declined "${d.title}"${body.reason ? `: "${String(body.reason).slice(0, 140)}"` : "."}${d.signer_phone ? " " + d.signer_phone : ""}`);
      return json({ ok: true });
    }
    if (action === "sign") {
      if (!d.consented_at) return json({ ok: false, error: "no_consent", message: "Please agree to sign electronically first." });
      if (!d.verified_at) return json({ ok: false, error: "not_verified", message: "Please confirm the code we texted you first." });
      const sig = typeof body.signature_png === "string" && body.signature_png.startsWith("data:image/png;base64,") && body.signature_png.length < 400_000 ? body.signature_png : null;
      const typed = String(body.typed_name || "").trim().slice(0, 120);
      if (!sig && !typed) return json({ ok: false, error: "no_signature", message: "Draw or type your signature." });
      // Required form answers
      if (d.form && Array.isArray(d.form.schema)) {
        const answers = Object.assign({}, d.form.answers || {}, body.answers && typeof body.answers === "object" ? body.answers : {});
        const missing = d.form.schema.filter((f: any) => f.req && !String(answers[f.id] ?? "").trim()).map((f: any) => f.label);
        if (missing.length) return json({ ok: false, error: "form_incomplete", message: `Please fill in: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`, missing });
        d.form = { schema: d.form.schema, answers };
      }
      if (typed && !d.signer_name) d.signer_name = typed;
      await audit(d, "signed", req, sig ? "drawn signature" : `typed "${typed}"`);
      d.signed_at = now();
      const bytes = await renderPdf(d, acct, sig, typed, d.audit, tz);
      const hash = await sha256Hex(bytes);
      const path = `${acct.id}/${d.id}.pdf`;
      const up = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (up.error) { console.error("upload", up.error); return json({ ok: false, error: "store_failed", message: "We couldn't save the signed copy. Please try again." }, 500); }
      await audit(d, "stored", req, `sha256 ${hash}`);
      const patch: any = { status: "signed", signed_at: d.signed_at, signature_png: null, pdf_path: path, pdf_sha256: hash, certificate_path: path, form: d.form, signer_name: d.signer_name, audit: d.audit, updated_at: now() };
      // Application fee
      let feeUrl: string | null = null;
      const feeCents = d.kind === "rental_application" ? Number(acct.settings?.real_estate?.application_fee_cents || 0) : 0;
      if (feeCents > 0 && !d.fee_invoice_id) { const inv = await createFeeInvoice(acct, d, feeCents); if (inv) { patch.fee_invoice_id = inv.id; feeUrl = inv.url; } }
      await supabase.from("re_documents").update(patch).eq("id", d.id);
      // Lead status
      if (d.lead_id) { const st = d.kind === "rental_application" ? "applied" : (d.kind === "showing_agreement" ? "showing_set" : null); const up2: any = { updated_at: now() }; if (st) up2.status = st; await supabase.from("re_leads").update(up2).eq("id", d.lead_id).in("status", ["new", "contacted", "showing_set"]); }
      // Confirmations
      const { data: su } = await supabase.storage.from(BUCKET).createSignedUrl(path, 7 * 86400);
      const copyLine = su?.signedUrl ? ` Your signed copy (good for 7 days): ${su.signedUrl}` : ` View your signed copy: ${signUrl(d.token)}`;
      if (d.signer_phone) await sendText(acct.id, d.signer_phone, `${acct.name}: thanks, ${d.signer_name || "you're"} all signed on "${d.title}".${feeUrl ? ` One more step — the ${money(feeCents)} application fee: ${feeUrl}` : ""}${copyLine}`);
      if (d.signer_email) { let bin = ""; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192)); const b64 = btoa(bin); await sendEmail(d.signer_email, `${acct.name} via Donna <donna@sidekicklogistics.com>`, `Signed: ${d.title}`, `Attached is your signed copy of "${d.title}" from ${acct.name}, with its signing certificate.${feeUrl ? `\n\nApplication fee (${money(feeCents)}): ${feeUrl}` : ""}\n\nDocument ID ${d.id}\nSHA-256 ${hash}`, { filename: `${d.title.replace(/[^a-z0-9]+/gi, "-")}.pdf`, content: b64 }); }
      const who = `${d.signer_name || "Someone"}${d.signer_phone ? " (" + d.signer_phone + ")" : ""}`;
      await notifyAgent(acct, d, `${who} just signed "${d.title}"${d.listing ? ` for ${d.listing.address}` : ""}.${d.kind === "rental_application" ? (feeUrl ? ` Fee link sent (${money(feeCents)}).` : "") + " Review it under Leads & documents." : d.appointment_id ? " The showing is confirmed." : ""} ${APP}`);
      // Showing confirmation to the caller once the agreement is in
      if (d.kind === "showing_agreement" && d.appointment_id) {
        const { data: ap } = await supabase.from("appointments").select("starts_at, notes").eq("id", d.appointment_id).maybeSingle();
        if (ap?.starts_at && d.signer_phone) await sendText(acct.id, d.signer_phone, `${acct.name}: you're confirmed for ${fmtWhen(ap.starts_at, tz)}${d.listing ? " at " + d.listing.address : ""}. Please bring a photo ID. Reply to this text if anything changes.`);
      }
      return json({ ok: true, fee_url: feeUrl, signed_url: su?.signedUrl || null });
    }
    return json({ ok: false, error: "unknown_action" }, 400);
  }

  // ================= Agent / internal =================
  const caller = await resolveCaller(req, body); if (!caller) return json({ ok: false, error: "unauthorized" }, 401);
  const acct = await loadAccount(caller.accountId); if (!acct) return json({ ok: false, error: "no_account" }, 404);
  const tz = acct.settings?.timezone || "America/Chicago";

  if (action === "doc_send") {
    const kind = String(body.kind || ""); if (!KIND_TITLES[kind]) return json({ ok: false, error: "bad_kind" }, 400);
    const phone = normPhone(body.signer_phone || ""); const email = String(body.signer_email || "").trim() || null;
    if (!phone && !email) return json({ ok: false, error: "no_recipient", message: "Need the signer's mobile or email." }, 400);
    let listing: any = null; if (body.listing_id) { const { data } = await supabase.from("re_listings").select("*").eq("id", body.listing_id).eq("account_id", acct.id).maybeSingle(); listing = data; }
    let lead: any = null; if (body.lead_id) { const { data } = await supabase.from("re_leads").select("*").eq("id", body.lead_id).eq("account_id", acct.id).maybeSingle(); lead = data; }
    const built = await buildDoc(acct, kind, Object.assign({}, body, { signer_name: body.signer_name || lead?.name || "" }), listing, caller);
    const row: any = { account_id: acct.id, kind, title: built.title, body_md: built.body_md, fields: built.fields, form: built.form, lead_id: lead?.id || null, listing_id: listing?.id || null, contact_id: lead?.contact_id || body.contact_id || null, appointment_id: body.appointment_id || null,
      signer_name: String(body.signer_name || lead?.name || "").trim() || null, signer_phone: phone || null, signer_email: email, status: "sent", sent_at: now(), created_by: caller.userId, agent_user_id: body.agent_user_id || lead?.agent_user_id || caller.userId || null,
      audit: [{ at: now(), event: "sent", ...clientMeta(req), detail: `by ${caller.name || "Donna"} to ${phone ? "•••" + phone.slice(-4) : email}` }] };
    const { data: d, error } = await supabase.from("re_documents").insert(row).select("*").maybeSingle();
    if (error || !d) return json({ ok: false, error: error?.message || "insert_failed" }, 400);
    const link = signUrl(d.token); const agent = built.fields.agent_name || acct.name;
    const intro = kind === "showing_agreement" ? `${acct.name}: before your showing${listing ? " at " + listing.address : ""}, please read and sign the short showing agreement: ${link}` : kind === "rental_application" ? `${acct.name}: here's the rental application${listing ? " for " + listing.address : ""}. It takes about 5 minutes on your phone: ${link}${built.fee_cents ? ` (${money(built.fee_cents)} application fee after you sign)` : ""}` : `${acct.name}: ${agent} asked me to send you "${built.title}" to review and sign: ${link}`;
    let sms = false, mail = false;
    if (phone) sms = await sendText(acct.id, phone, intro);
    if (email) mail = await sendEmail(email, `${acct.name} via Donna <donna@sidekicklogistics.com>`, `${built.title} from ${acct.name}`, `${intro}\n\nThis link is personal to you and expires in 14 days.`);
    if (!sms && !mail) { await supabase.from("re_documents").update({ status: "draft" }).eq("id", d.id); return json({ ok: false, error: "not_sent", message: "The text didn't go through." }); }
    return json({ ok: true, document: { id: d.id, token: d.token, status: d.status, title: d.title }, url: link, sent: { sms, email: mail } });
  }
  if (action === "doc_resend" || action === "doc_void" || action === "doc_url") {
    const { data: d } = await supabase.from("re_documents").select("*, re_listings(address)").eq("id", String(body.id || "")).eq("account_id", acct.id).maybeSingle();
    if (!d) return json({ ok: false, error: "not_found" }, 404);
    if (action === "doc_url") { const path = body.which === "certificate" ? (d.certificate_path || d.pdf_path) : d.pdf_path; if (!path) return json({ ok: false, error: "no_file" }); const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600); return json({ ok: true, url: data?.signedUrl || null }); }
    if (action === "doc_void") { if (d.status === "signed") return json({ ok: false, error: "already_signed" }); const a = Array.isArray(d.audit) ? d.audit : []; a.push({ at: now(), event: "voided", detail: `by ${caller.name || "agent"}` }); await supabase.from("re_documents").update({ status: "void", audit: a, updated_at: now() }).eq("id", d.id); return json({ ok: true }); }
    if (!["sent", "viewed", "verified"].includes(d.status)) return json({ ok: false, error: "not_open" });
    const link = signUrl(d.token); let sms = false, mail = false;
    if (d.signer_phone) sms = await sendText(acct.id, d.signer_phone, `${acct.name}: a reminder to read and sign "${d.title}"${d.re_listings ? " for " + d.re_listings.address : ""}: ${link}`);
    if (d.signer_email) mail = await sendEmail(d.signer_email, `${acct.name} via Donna <donna@sidekicklogistics.com>`, `Reminder: ${d.title}`, `Please read and sign: ${link}`);
    const a = Array.isArray(d.audit) ? d.audit : []; a.push({ at: now(), event: "resent", detail: `by ${caller.name || "agent"}` }); await supabase.from("re_documents").update({ audit: a, expires_at: new Date(Date.now() + 14 * 86400000).toISOString(), updated_at: now() }).eq("id", d.id);
    return json({ ok: sms || mail, sent: { sms, email: mail } });
  }
  if (action === "send_iabs") {
    const s = acct.settings?.real_estate || {}; if (!s.iabs_url) return json({ ok: false, error: "no_iabs", message: "Add your IABS link under Settings → Real estate first." });
    let lead: any = null; if (body.lead_id) { const { data } = await supabase.from("re_leads").select("*").eq("id", body.lead_id).eq("account_id", acct.id).maybeSingle(); lead = data; }
    const phone = normPhone(body.phone || lead?.phone || ""); if (!phone) return json({ ok: false, error: "no_phone" }, 400);
    if (lead?.iabs_sent_at && !body.force) return json({ ok: true, already: true });
    const ok = await sendText(acct.id, phone, `${acct.name}: Texas law asks us to share the Information About Brokerage Services notice with everyone we talk to about real estate. Here it is: ${s.iabs_url} — nothing to sign, just for your records.`);
    if (ok && lead) await supabase.from("re_leads").update({ iabs_sent_at: now(), updated_at: now() }).eq("id", lead.id);
    else if (ok && !lead) { await supabase.from("re_leads").update({ iabs_sent_at: now() }).eq("account_id", acct.id).eq("phone", phone).is("iabs_sent_at", null); }
    return json({ ok });
  }
  if (action === "signed_for") {
    const phone = normPhone(body.phone || ""); if (!phone) return json({ ok: true, signed: false });
    let q = supabase.from("re_documents").select("id, signed_at, listing_id").eq("account_id", acct.id).eq("kind", "showing_agreement").eq("status", "signed").eq("signer_phone", phone).gte("signed_at", new Date(Date.now() - 180 * 86400000).toISOString()).order("signed_at", { ascending: false }).limit(1);
    const { data } = await q; const d = data?.[0];
    return json({ ok: true, signed: !!d, document: d || null });
  }
  if (action === "list") {
    const { data } = await supabase.from("re_documents").select("id, kind, title, status, signer_name, signer_phone, sent_at, signed_at, listing_id, lead_id").eq("account_id", acct.id).order("created_at", { ascending: false }).limit(Number(body.limit) || 100);
    return json({ ok: true, documents: data || [] });
  }
  return json({ ok: false, error: "unknown_action" }, 400);
});
