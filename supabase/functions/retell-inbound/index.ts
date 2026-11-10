import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna — Retell inbound-call webhook (emits greeting, routing, memory, voice). v45: trip_fee + after_hours vars (prepay only when cards are live). v47: card processing fee note in trip_fee. v48: real_estate var.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const TRANS_MODEL = "claude-haiku-4-5-20251001";

const VOICE_MAP: Record<string, string> = {
  "warm-female": "minimax-Cimo",
  "pro-female": "minimax-Kate",
  "warm-male": "minimax-Adrian",
  "pro-male": "minimax-Andrew",
};
const DEFAULT_VOICE = "minimax-Cimo";

const LANG_NAMES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", ru: "Russian",
  ar: "Arabic", hi: "Hindi", zh: "Mandarin", yue: "Cantonese", vi: "Vietnamese",
  ur: "Urdu", pa: "Punjabi", gu: "Gujarati", bn: "Bengali", ta: "Tamil", te: "Telugu",
  fa: "Persian", tr: "Turkish", ps: "Pashto", pt: "Portuguese", it: "Italian",
  ja: "Japanese", ko: "Korean", nl: "Dutch", th: "Thai",
};
const TRANS_LANG: Record<string, string> = {
  es: "Spanish", fr: "French", de: "German", it: "Italian", nl: "Dutch",
  pt: "Portuguese (Brazilian)", ru: "Russian", ar: "Arabic", fa: "Persian (Farsi)", hi: "Hindi",
  zh: "Mandarin Chinese using Simplified characters", yue: "Cantonese using Traditional Chinese characters",
  ja: "Japanese", ko: "Korean", vi: "Vietnamese", th: "Thai",
};
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function looksLikeName(s: string): boolean {
  return /^[\p{L}][\p{L}'’-]{1,19}$/u.test(String(s || "").trim());
}
function withinWindows(tz: string, windows: any[], now: Date): boolean {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const dow = DOW[wd] ?? -1;
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return windows.some((w: any) => Number(w?.dow) === dow && String(w?.start) <= hm && hm < String(w?.end));
}
function firstName(n: string): string { return String(n || "").trim().split(/\s+/)[0] || ""; }
function langCode(langName: unknown): string {
  const s = String(langName || "").toLowerCase();
  if (/mandarin|chinese|putonghua|guoyu|^zh/.test(s)) return "zh";
  if (/cantonese|^yue/.test(s)) return "yue";
  if (/span|espa|castellano|^es/.test(s)) return "es";
  if (/fren|franç|franc|^fr/.test(s)) return "fr";
  if (/germ|deutsch|^de/.test(s)) return "de";
  if (/ital|^it/.test(s)) return "it";
  if (/dutch|nederl|^nl/.test(s)) return "nl";
  if (/portug|brasil|brazil|^pt/.test(s)) return "pt";
  if (/russ|русс|^ru/.test(s)) return "ru";
  if (/arab|^ar/.test(s)) return "ar";
  if (/persian|farsi|dari|^fa/.test(s)) return "fa";
  if (/hindi|^hi/.test(s)) return "hi";
  if (/japan|nihongo|^ja/.test(s)) return "ja";
  if (/korean|^ko/.test(s)) return "ko";
  if (/viet|^vi/.test(s)) return "vi";
  if (/thai|^th/.test(s)) return "th";
  return "en";
}
async function translatePhrase(text: string, languageName: string): Promise<string> {
  if (!ANTHROPIC_KEY || !text) return "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: TRANS_MODEL, max_tokens: 300,
        system: "You are a professional translator for a phone receptionist. Translate the user's short phrase into the target language so it can be spoken aloud naturally and politely to a caller. Output only the translation, with no quotes, notes, romanization, or extra text.",
        messages: [{ role: "user", content: `Target language: ${languageName}\nPhrase: ${text}` }] }),
    });
    if (r.status === 200) {
      const j = await r.json().catch(() => ({}));
      const t = Array.isArray(j?.content) ? (j.content.find((b: any) => b.type === "text")?.text ?? "") : "";
      return String(t || "").trim();
    }
    console.error("translate non-200", r.status);
  } catch (e) { console.error("translate threw", String(e)); }
  return "";
}

type G = { rec: string; closer: string; ret: (f: string, l: string) => string; neu: (n: string, l: string) => string };
const GREETINGS: Record<string, G> = {
  en: { rec: "Just so you know, this call may be recorded for quality and training. ", closer: "How can I help you?",
    ret: (f, l) => `Hi ${f}, thanks for calling ${l} again. `, neu: (n, l) => `Hello, this is ${n} with ${l}. ` },
  es: { rec: "Le informo que esta llamada puede ser grabada para calidad y capacitación. ", closer: "¿En qué puedo ayudarle?",
    ret: (f, l) => `Hola ${f}, gracias por llamar de nuevo a ${l}. `, neu: (n, l) => `Hola, le atiende ${n} de ${l}. ` },
  fr: { rec: "Je vous informe que cet appel peut être enregistré à des fins de qualité et de formation. ", closer: "Comment puis-je vous aider ?",
    ret: (f, l) => `Bonjour ${f}, merci de rappeler ${l}. `, neu: (n, l) => `Bonjour, ${n} de ${l} à votre écoute. ` },
  de: { rec: "Zur Information: Dieser Anruf kann zu Qualitäts- und Schulungszwecken aufgezeichnet werden. ", closer: "Wie kann ich Ihnen helfen?",
    ret: (f, l) => `Hallo ${f}, schön, dass Sie wieder bei ${l} anrufen. `, neu: (n, l) => `Hallo, hier ist ${n} von ${l}. ` },
  it: { rec: "La informo che questa chiamata potrebbe essere registrata per qualità e formazione. ", closer: "Come posso aiutarla?",
    ret: (f, l) => `Ciao ${f}, grazie per aver richiamato ${l}. `, neu: (n, l) => `Salve, sono ${n} di ${l}. ` },
  nl: { rec: "Ter info: dit gesprek kan worden opgenomen voor kwaliteit en training. ", closer: "Hoe kan ik u helpen?",
    ret: (f, l) => `Hallo ${f}, fijn dat u weer met ${l} belt. `, neu: (n, l) => `Hallo, u spreekt met ${n} van ${l}. ` },
  pt: { rec: "Informo que esta chamada pode ser gravada para fins de qualidade e treinamento. ", closer: "Como posso ajudar?",
    ret: (f, l) => `Olá ${f}, obrigada por ligar novamente para ${l}. `, neu: (n, l) => `Olá, aqui é a ${n} da ${l}. ` },
  ru: { rec: "Обращаю внимание, что этот звонок может записываться для контроля качества и обучения. ", closer: "Чем я могу вам помочь?",
    ret: (f, l) => `Здравствуйте, ${f}, спасибо, что снова звоните в ${l}. `, neu: (n, l) => `Здравствуйте, это ${n} из ${l}. ` },
  ar: { rec: "للعلم، قد يتم تسجيل هذه المكالمة لأغراض الجودة والتدريب. ", closer: "كيف يمكنني مساعدتك؟",
    ret: (f, l) => `مرحباً ${f}، شكراً لاتصالك مجدداً بـ ${l}. `, neu: (n, l) => `مرحباً، معك ${n} من ${l}. ` },
  fa: { rec: "به اطلاع می‌رسانم این تماس ممکن است برای کیفیت و آموزش ضبط شود. ", closer: "چطور می‌توانم کمکتان کنم؟",
    ret: (f, l) => `سلام ${f}، ممنون که دوباره با ${l} تماس گرفتید. `, neu: (n, l) => `سلام، من ${n} از ${l} هستم. ` },
  hi: { rec: "आपकी जानकारी के लिए, यह कॉल गुणवत्ता और प्रशिक्षण के लिए रिकॉर्ड की जा सकती है। ", closer: "मैं आपकी कैसे मदद कर सकती हूँ?",
    ret: (f, l) => `नमस्ते ${f}, ${l} पर दोबारा कॉल करने के लिए धन्यवाद। `, neu: (n, l) => `नमस्ते, मैं ${l} से ${n} बोल रही हूँ। ` },
  zh: { rec: "为了保证服务质量，本次通话可能会被录音。", closer: "请问有什么可以帮您？",
    ret: (f, l) => `您好，${f}，欢迎再次致电${l}。`, neu: (n, l) => `您好，这里是${l}。` },
  yue: { rec: "為咗保證服務質素，今次通話可能會錄音。", closer: "請問有咗可以幫到你？",
    ret: (f, l) => `你好，${f}，多謝你再次致電${l}。`, neu: (n, l) => `你好，呢度係${l}。` },
  ja: { rec: "この通話は品質向上と研修のため録音される場合がございます。", closer: "ご用件をお伺いします。",
    ret: (f, l) => `もしもし ${f} さん、${l} にまたお電話いただきありがとうございます。`, neu: (n, l) => `お電話ありがとうございます、${l} の ${n} です。` },
  ko: { rec: "본 통화는 품질 및 교육을 위해 녹음될 수 있습니다. ", closer: "무엇을 도와드릴까요?",
    ret: (f, l) => `안녕하세요 ${f}님, ${l}에 다시 전화 주셔서 감사합니다. `, neu: (n, l) => `안녕하세요, ${l}의 ${n}입니다. ` },
  vi: { rec: "Xin lưu ý cuộc gọi này có thể được ghi âm để đảm bảo chất lượng. ", closer: "Tôi có thể giúp gì cho bạn?",
    ret: (f, l) => `Xin chào ${f}, cảm ơn bạn đã gọi lại ${l}. `, neu: (n, l) => `Xin chào, đây là ${n} từ ${l}. ` },
  th: { rec: "ขอเรียนให้ทราบว่าสายนี้อาจถูกบันทึกเพื่อคุณภาพและการฝึกอบรม ", closer: "มีอะไรให้ช่วยไหมคะ",
    ret: (f, l) => `สวัสดีค่ะคุณ ${f} ขอบคุณที่โทรกลับมาที่ ${l} ค่ะ `, neu: (n, l) => `สวัสดีค่ะ ${n} จาก ${l} ค่ะ ` },
};

function buildGreeting(code: string, firstName: string, name: string, label: string, recordingOn: boolean, opening: string): string {
  const g = GREETINGS[code] || GREETINGS.en;
  const rec = recordingOn ? g.rec : "";
  const closer = opening || g.closer;
  const prefix = firstName ? g.ret(firstName, label) : g.neu(name, label);
  return prefix + rec + closer;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }
  const empty = () => new Response(JSON.stringify({ call_inbound: {} }), { headers: { "Content-Type": "application/json" } });

  let body: any = {};
  try { body = await req.json(); } catch { return empty(); }

  const inbound = body?.call_inbound ?? {};
  const toNumber = inbound.to_number;
  const fromNumber = String(inbound.from_number || "").trim();
  if (!toNumber) return empty();

  const { data: asst, error } = await supabase
    .from("assistants")
    .select("assistant_name, greeting_label, routing, is_active, languages, account_id, voice_id, opening_question_i18n, accounts(name, settings, plan, industry)")
    .eq("twilio_number", toNumber)
    .maybeSingle();
  if (error || !asst) return empty();

  const retellVoice = VOICE_MAP[String((asst as any).voice_id || "")] || DEFAULT_VOICE;

  if (!asst.is_active) {
    const pausedRouting = (asst.routing as any) || {};
    const fwdNumber = String(pausedRouting.paused_forward_number || "").trim();
    if (!fwdNumber) return empty();
    const pausedAcct: any = (asst.accounts as any) || {};
    return new Response(
      JSON.stringify({
        call_inbound: {
          dynamic_variables: {
            paused: "yes",
            transfer_number: fwdNumber,
            can_transfer: "yes",
            assistant_name: asst.assistant_name || "Donna",
            business_name: asst.greeting_label || pausedAcct.name || "",
          },
          agent_override: { agent: { voice_id: retellVoice }, retell_llm: { begin_message: "One moment, let me connect you." } },
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const name = asst.assistant_name || "Donna";
  const label = asst.greeting_label || "the office";
  const routing = (asst.routing as any) || {};
  const recordingOn = !(routing.recording_notice === false);
  const acct: any = (asst.accounts as any) || {};
  const settings: any = acct?.settings || {};
  const tz = settings.timezone || "America/Chicago";
  const business = asst.greeting_label || acct.name || "";
  const plan = String(acct?.plan || "starter");
  const isPro = plan === "pro";
  const salonTeam = settings?.features?.salon === true && (plan === "pro" || plan === "enterprise");
  const isSalon = settings?.features?.salon === true;
  const isRealEstate = String(acct?.industry || settings?.industry || "") === "real_estate";
  const isPm = settings?.features?.property_management === true && !isSalon && !isRealEstate;
  const industry = isSalon ? "salon" : (isPm ? "property_management" : String(settings?.industry || acct?.industry || "general"));
  const smsOn = settings?.sms?.enabled === true && settings?.sms?.confirmations !== false;
  // Who this business sells to. Only B2B shops get the "what business do you run / what are you interested in" intake.
  const b2b = !isSalon && !isPm && /software|consult|professional|agency|marketing|legal|law|account|b2b|wholesale|logistic|staffing|it services/i.test(String(acct?.industry || settings?.industry || ""));
  const canTextLinks = smsOn && settings?.booking?.enabled === true;
  const providerLabel = String(settings?.provider_label || "stylist");
  const providerLabelPlural = providerLabel + "s";
  // Contractor pricing rules, read aloud on calls (never invented): trip fee and after-hours policy.
  const ctr: any = settings?.contractor || {};
  const fmt$ = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
  let tripFeeText = "none";
  if (industry === "contractor") {
    const tf = Number(ctr.trip_fee_cents || 0);
    tripFeeText = tf > 0 ? `${fmt$(tf)} service-call / trip fee${ctr.trip_fee_waived_if_work === false ? ", charged even if the work is done" : ", waived if the customer goes ahead with the work"}` : "no trip fee";
    // Card processing fee (settings.payments.card_fee_pct): only if the caller asks about paying by card; cash and check never pay it.
    const cardPct = Number(settings?.payments?.card_fee_pct || 0);
    if (cardPct > 0) tripFeeText += `. If asked about paying by card: a ${cardPct}% card processing fee is added when paying by card; cash or check has no fee. Don't bring it up unless they ask about payment.`;
  }
  let afterHoursText = "n/a";
  if (industry === "contractor") {
    const ds = Number(ctr.day_start_hour ?? 7), de = Number(ctr.day_end_hour ?? 19);
    const hrs = `${ds % 12 || 12}${ds < 12 ? "am" : "pm"} to ${de % 12 || 12}${de < 12 ? "am" : "pm"}, Monday through Saturday`;
    if (ctr.after_hours_enabled === true) {
      const mult = Number(ctr.after_hours_multiplier || 0), flat = Number(ctr.after_hours_fee_cents || 0);
      const charge = flat > 0 ? `an extra ${fmt$(flat)} after-hours charge` : (mult > 1 ? `${mult}x the regular price` : "the regular price");
      // Prepay is only promised when the shop's own Stripe can take cards right now.
      let prepay = ctr.after_hours_prepay === true && flat > 0 && settings?.payments?.enabled === true;
      if (prepay) { try { const { data: pa } = await supabase.from("payment_accounts").select("charges_enabled").eq("account_id", asst.account_id).maybeSingle(); prepay = (pa as any)?.charges_enabled === true; } catch { prepay = false; } }
      afterHoursText = `YES: we take after-hours and emergency jobs outside ${hrs} and on Sundays at ${charge}. For an after-hours job, get the address and the problem, then use take_message with urgent=true${prepay ? `; the caller is texted a secure link to pay the ${fmt$(flat)} after-hours fee first, and the on-call tech is paged the moment it's paid (say this plainly, and that the fee is applied to the visit)` : "; the on-call tech is paged by text and calls back within 15 minutes"}.`;
    } else {
      afterHoursText = `NO: regular hours are ${hrs}. Outside those, book the next regular opening; for a true emergency take an urgent message and give the safety advice.`;
    }
  }

  // Real estate: what Donna knows about the agent's practice (facts only; she never prices, never gives legal advice).
  let realEstateText = "n/a";
  if (isRealEstate) {
    const re: any = settings?.real_estate || {};
    const lines: string[] = Array.isArray(re.lines) && re.lines.length ? re.lines : ["residential"];
    const lineWords: Record<string, string> = { residential: "residential homes", commercial: "commercial property (sale and lease)", land: "land and acreage", rentals: "rental homes and leasing" };
    let listingCount = 0; try { const { count } = await supabase.from("re_listings").select("id", { count: "exact", head: true }).eq("account_id", asst.account_id).in("status", ["coming_soon", "active", "pending"]); listingCount = count || 0; } catch { /* */ }
    const parts = [
      `YES, this is a real estate business. ${re.agent_name || business} handles ${lines.map((l) => lineWords[l] || l).join(", ")}.`,
      listingCount ? `${listingCount} listing${listingCount === 1 ? "" : "s"} on the books: use listing_lookup for any question about a property, price, bedrooms, availability, pets, or a showing.` : "No listings on the books right now: take the lead with re_lead and say the agent will follow up.",
      re.license_no ? `License #${re.license_no}${re.broker_name ? ", sponsored by " + re.broker_name : ""}.` : (re.broker_name ? `Sponsored by ${re.broker_name}.` : ""),
      re.iabs_url ? "IABS notice is texted automatically by the tools; if asked, say it was (or will be) texted." : "No IABS link on file; don't mention it.",
      re.require_showing_agreement === false ? "Showings book right away; a showing agreement is texted for the record." : "A short showing agreement is texted after booking a showing; the showing is confirmed once it's signed.",
      Number(re.application_fee_cents || 0) > 0 ? `Rental application fee: ${fmt$(Number(re.application_fee_cents))}, paid by card after the applicant signs; never collect card numbers by phone.` : "No rental application fee.",
      re.lender_partner?.name ? `Lender partner: ${re.lender_partner.name}. Offer the referral only to buyers who are not pre-approved and say yes; re_lead with lender_referral=true texts it.` : "No lender partner; don't recommend one.",
      settings?.features?.property_management === true ? "This agent ALSO manages rental properties for owners, so the property-management section below applies too for tenants calling about repairs, rent, or their lease." : "",
    ].filter(Boolean);
    realEstateText = parts.join(" ");
  }

  const customInstructions = String(routing.custom_instructions || "").trim();
  const openingQuestion = String(routing.opening_question || "").trim();

  const codesArr = (Array.isArray(asst.languages) && asst.languages.length) ? asst.languages : ["en"];
  const languages = codesArr.map((c: string) => LANG_NAMES[c] || c).join(", ");

  const now = new Date();
  const current_date = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now);
  const current_time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);

  let knownCaller = false, callerName = "", callerFirst = "", callerCompany = "";
  let callerInterest = "", callerLastSummary = "", preferredLanguage = "", callerPron = "", callerMemory = "";
  let callerHasEmail = false;
  let usualService = "", usualStylist = "", usualStylistId: string | null = null, nextAppt = "", clientFlags = "";
  if (fromNumber) {
    const { data: contactRows } = await supabase
      .from("contacts")
      .select("id, name, preferred_name, pronunciation, company, interest, language, last_call_summary, memory, list_type, email, allergies, preferences, stylist_notes")
      .eq("account_id", asst.account_id).eq("phone", fromNumber)
      .order("last_call_at", { ascending: false, nullsFirst: false }).order("updated_at", { ascending: false }).limit(1);
    const contact = contactRows && contactRows[0];
    if (contact && contact.list_type !== "blacklist") {
      knownCaller = true;
      callerName = String(contact.name || "").trim();
      const pref = String(contact.preferred_name || "").trim();
      callerFirst = pref || (callerName ? callerName.split(/\s+/)[0] : "");
      callerPron = String(contact.pronunciation || "").trim();
      callerCompany = String(contact.company || "").trim();
      callerInterest = String(contact.interest || "").trim();
      preferredLanguage = String(contact.language || "").trim();
      callerLastSummary = String(contact.last_call_summary || "").trim();
      callerMemory = String(contact.memory || "").trim();
      callerHasEmail = String((contact as any).email || "").includes("@");
      clientFlags = [(contact as any).allergies ? "Allergies/sensitivities: " + (contact as any).allergies : "", (contact as any).preferences ? "Preferences: " + (contact as any).preferences : ""].filter(Boolean).join(". ");
      // "Your usual": the service and stylist of their most recent visit, plus anything already booked.
      try {
        const { data: past } = await supabase.from("appointments").select("title, user_id, starts_at").eq("account_id", asst.account_id).eq("contact_id", (contact as any).id).neq("status", "cancelled").lt("starts_at", now.toISOString()).order("starts_at", { ascending: false }).limit(1);
        const { data: fut } = await supabase.from("appointments").select("title, user_id, starts_at").eq("account_id", asst.account_id).eq("contact_id", (contact as any).id).in("status", ["scheduled", "confirmed"]).gt("starts_at", now.toISOString()).order("starts_at", { ascending: true }).limit(1);
        const svcOf = (t: string) => { const m = /^(.*?)\s+with\s+/i.exec(String(t || "")); return (m ? m[1] : String(t || "")).trim(); };
        const nameOf = async (uid: string | null) => { if (!uid) return ""; const { data: u } = await supabase.from("users").select("full_name").eq("id", uid).maybeSingle(); return firstName(String((u as any)?.full_name || "")); };
        const last = (past || [])[0] as any; const nxt = (fut || [])[0] as any;
        if (last) { usualService = svcOf(last.title); usualStylist = await nameOf(last.user_id); usualStylistId = last.user_id || null; }
        if (nxt) { const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(nxt.starts_at)); const who = await nameOf(nxt.user_id); nextAppt = `${svcOf(nxt.title)}${who ? " with " + who : ""} on ${w}`; }
      } catch (_e) { /* best effort */ }
    }
    if (!callerLastSummary) {
      const { data: lastCall } = await supabase
        .from("calls").select("summary")
        .eq("account_id", asst.account_id).eq("from_number", fromNumber)
        .not("summary", "is", null).order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (lastCall?.summary) callerLastSummary = String(lastCall.summary).trim();
    }
  }
  if (!looksLikeName(callerFirst)) callerFirst = "";
  if (callerPron) callerFirst = callerPron;
  if (callerLastSummary.length > 400) callerLastSummary = callerLastSummary.slice(0, 400);
  if (callerMemory.length > 1200) callerMemory = callerMemory.slice(0, 1200);

  // Account-level "working" (live transfer) windows, used for non-salon transfer gating.
  let windows: any[] = [];
  let winTz = tz;
  const { data: workRows } = await supabase
    .from("availability_rules").select("day_of_week, start_time, end_time")
    .eq("account_id", asst.account_id).eq("rule_type", "working");
  if (Array.isArray(workRows) && workRows.length) {
    windows = workRows.map((r: any) => ({ dow: Number(r.day_of_week), start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) }));
  } else {
    const bh = routing.business_hours || {};
    winTz = bh.timezone || tz;
    windows = Array.isArray(bh.windows) ? bh.windows : [];
  }
  const openNow = withinWindows(winTz, windows, now);

  const transfer = routing.transfer || {};
  const singleNumber = String(transfer.number || "").trim();
  const directory = Array.isArray(routing.directory) ? routing.directory : [];
  const withPhone = directory.filter((p: any) => p && String(p.phone || "").trim());
  const general = withPhone.filter((p: any) => p.general === true).sort((a: any, b: any) => (Number(a.order) || 999) - (Number(b.order) || 999));
  const useDirectory = isPro && withPhone.length > 0;
  const primaryNumber = useDirectory ? String((general[0] || withPhone[0]).phone).trim() : singleNumber;
  const transferEnabled = transfer.enabled === true && primaryNumber.length > 0;

  let canTransfer = transferEnabled && openNow;
  let transferNumberVar = primaryNumber;
  let directoryText = useDirectory ? withPhone.map((p: any) => `${p.name}: ${String(p.phone).trim()}`).join("\n") : "";
  let hasDirectory = useDirectory && canTransfer;
  const generalList = useDirectory ? general.map((p: any) => String(p.phone).trim()).join(", ") : "";

  // Salon context: stylist list, services, and a per-stylist transfer directory gated by
  // each person's OWN hours (live-transfer hours, falling back to their booking hours),
  // plus the salon's own transfer line gated by the owner's hours.
  let isSalonTeam = "no", stylistsVar = "", servicesVar = "", servicesDetail = "", stylistsSay = "", soloName = "";
  if (!isPm) {   // every service business (salon or not) gets its menu with durations and prices
    const { data: svcRows } = await supabase.from("appointment_types").select("name, default_duration_min, price, category, description").eq("account_id", asst.account_id).eq("is_active", true).order("created_at");
    const fmtDur = (m: number) => !m ? "" : (m >= 60 ? (m % 60 ? (m / 60).toFixed(1).replace(/\.0$/, "") + " hr" : (m / 60) + " hr") : m + " min");
    servicesVar = (svcRows || []).map((s: any) => s.name).filter(Boolean).join(", ");
    servicesDetail = (svcRows || []).map((s: any) => `${s.name}${s.default_duration_min ? " · " + fmtDur(Number(s.default_duration_min)) : ""}${s.price ? " · " + s.price : ""}`).join("; ");
    if (isSalon) {
      const { data: ppl } = await supabase.from("users").select("id, full_name, pronunciation, is_bookable, role, created_at").eq("account_id", asst.account_id).order("created_at");
      const bookablePpl = (ppl || []).filter((u: any) => u.is_bookable);
      const prov = bookablePpl.length ? bookablePpl : (ppl || []).filter((u: any) => u.role === "owner").slice(0, 1);
      stylistsSay = prov.map((u: any) => { const f = firstName(u.full_name); return u.pronunciation ? `${f} (said "${u.pronunciation}")` : f; }).join(", ");
      if (prov.length === 1) soloName = firstName(prov[0].full_name);
    }
  }
  if (salonTeam) {
    isSalonTeam = "yes";
    const [{ data: staff }, { data: rules }, { data: blocks }, { data: svcs }] = await Promise.all([
      supabase.from("users").select("id, full_name, phone, role, is_bookable, created_at").eq("account_id", asst.account_id).order("created_at"),
      supabase.from("availability_rules").select("user_id, rule_type, day_of_week, start_time, end_time").eq("account_id", asst.account_id),
      supabase.from("calendar_blocks").select("user_id, starts_at, ends_at").eq("account_id", asst.account_id).gt("ends_at", now.toISOString()),
      supabase.from("appointment_types").select("name").eq("account_id", asst.account_id).eq("is_active", true).order("created_at"),
    ]);
    const users = (staff || []) as any[];
    const rl = (rules || []) as any[];
    const bl = (blocks || []) as any[];
    const nowMs = now.getTime();
    const blockedNow = (userId: string) => bl.some((b: any) => (b.user_id === userId || b.user_id == null) && new Date(b.starts_at).getTime() <= nowMs && nowMs < new Date(b.ends_at).getTime());
    const winsFor = (userId: string, kind: string) => rl.filter((r: any) => r.user_id === userId && r.rule_type === kind).map((r: any) => ({ dow: Number(r.day_of_week), start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) }));
    const reachableNow = (userId: string): boolean => {
      if (blockedNow(userId)) return false;
      const w = winsFor(userId, "working");
      if (w.length) return withinWindows(tz, w, now);
      const b = winsFor(userId, "bookable");
      return b.length ? withinWindows(tz, b, now) : false;
    };

    const bookableNames = users.filter((u) => u.is_bookable).map((u) => firstName(u.full_name) || u.full_name).filter(Boolean);
    stylistsVar = bookableNames.join(", ");
    if (!servicesVar) servicesVar = (svcs || []).map((s: any) => s.name).filter(Boolean).join(", ");

    // Per-person transfer directory: anyone with a phone who is reachable right now.
    const dirEntries = users.filter((u) => String(u.phone || "").trim() && reachableNow(u.id)).map((u) => `${u.full_name}: ${String(u.phone).trim()}`);
    const owner = users.find((u) => u.role === "owner") || users[0];
    const ownerReachable = owner ? reachableNow(owner.id) : false;

    const salonTransferOn = transfer.enabled === true;
    const salonNumber = (ownerReachable && singleNumber) ? singleNumber : "";
    directoryText = dirEntries.join("\n");
    transferNumberVar = salonNumber;
    canTransfer = salonTransferOn && (dirEntries.length > 0 || salonNumber.length > 0);
    hasDirectory = canTransfer && dirEntries.length > 0;
  }

  const code = langCode(preferredLanguage);
  let spokenOpening = openingQuestion;
  if (code !== "en" && openingQuestion) {
    const cache: any = (asst as any).opening_question_i18n || {};
    if (cache.source === openingQuestion && cache.t && cache.t[code]) {
      spokenOpening = String(cache.t[code]);
    } else {
      const tname = TRANS_LANG[code] || preferredLanguage || code;
      const translated = await translatePhrase(openingQuestion, tname);
      if (translated) {
        spokenOpening = translated;
        const base: any = (cache.source === openingQuestion && cache.t) ? cache : { source: openingQuestion, t: {} };
        base.t = base.t || {};
        base.t[code] = translated;
        try { await supabase.from("assistants").update({ opening_question_i18n: base }).eq("twilio_number", toNumber); } catch (_e) { /* best effort */ }
      }
    }
  }

  const greeting = buildGreeting(code, callerFirst, name, label, recordingOn, spokenOpening);

  return new Response(
    JSON.stringify({
      call_inbound: {
        dynamic_variables: {
          assistant_name: name, greeting_label: label, business_name: business,
          recording_notice: recordingOn ? "enabled" : "disabled",
          custom_instructions: customInstructions, opening_question: openingQuestion,
          current_date, current_time, timezone: tz, languages,
          transfer_number: transferNumberVar,
          can_transfer: canTransfer ? "yes" : "no",
          business_hours_open: openNow ? "yes" : "no",
          has_directory: hasDirectory ? "yes" : "no",
          transfer_directory: directoryText, transfer_general_list: generalList,
          known_caller: knownCaller ? "yes" : "no",
          caller_name: callerName, caller_first_name: callerFirst,
          caller_company: callerCompany, caller_interest: callerInterest,
          caller_last_summary: callerLastSummary, caller_memory: callerMemory,
          caller_has_email: callerHasEmail ? "yes" : "no",
          preferred_language: preferredLanguage,
          is_salon_team: isSalonTeam, stylists: stylistsVar, services: servicesVar,
          industry, services_detail: servicesDetail, stylists_say: stylistsSay, solo_stylist: soloName, sms_on: smsOn ? "yes" : "no",
          b2b: b2b ? "yes" : "no", booking_link: canTextLinks ? "yes" : "no",
          usual_service: usualService, usual_stylist: usualStylist, next_appointment: nextAppt, client_flags: clientFlags,
          provider_label: providerLabel, provider_label_plural: providerLabelPlural,
          trip_fee: tripFeeText, after_hours: afterHoursText, real_estate: realEstateText,
          paused: "no",
        },
        agent_override: { agent: { voice_id: retellVoice }, retell_llm: { begin_message: greeting } },
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
