import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna crew-text (v11): the contractor runs his day by texting Donna's number from his own phone.
// Called by msg-inbound when the sender is a user (owner or tech) on the account. Returns { handled, reply }.
// Commands (forgiving, case-insensitive):
//   omw / on my way [20]      -> customer gets "on the way, about 20 min"
//   here / start              -> job in progress
//   done                      -> confirm the work: lines + add-on menu -> total -> SEND / LATER / PAID
//   late 15                   -> customer gets "running about 15 min behind"
//   today / jobs              -> today's list        next -> next job with address + map link
//   note <text>               -> note on the current job      photo (MMS) -> saved to the current job
//   help                      -> the list
// Everything goes through `jobs` and `payments` with the service role + user_id, so the text path and the app share one brain.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...CORS, "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const parseMoney = (s: string): number | null => { const m = String(s || "").replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/); return m ? Math.round(parseFloat(m[1]) * 100) : null; };

async function call(fn: string, body: any): Promise<any> {
  try { const r = await fetch(`${SELF}/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify(body) }); return await r.json().catch(() => ({})); } catch { return {}; }
}
function fmtTime(iso: string, tz: string) { return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
const first = (n: string) => String(n || "").trim().split(/\s+/)[0] || "the customer";
const mapLink = (a: string) => `https://maps.google.com/?q=${encodeURIComponent(a)}`;

// Which job does "done" mean? In progress or en route first, then the next one coming up, then the last one today.
function pickCurrent(jobs: any[]): any | null {
  if (!jobs?.length) return null;
  const active = jobs.find((j) => j.status === "in_progress") || jobs.find((j) => j.status === "en_route"); if (active) return active;
  const open = jobs.filter((j) => !["done", "invoiced", "paid", "cancelled"].includes(j.status));
  const now = Date.now();
  const upcoming = open.find((j) => new Date(j.ends_at || j.starts_at).getTime() >= now - 3 * 3600 * 1000);
  return upcoming || open[open.length - 1] || jobs[jobs.length - 1];
}
function linesSummary(lines: any[]) { return lines.map((l) => `${l.desc}${l.qty > 1 ? ` x${l.qty}` : ""}: ${l.cents === 0 ? "no charge" : money(l.cents)}`).join("\n"); }
function total(lines: any[]) { return lines.reduce((s, l) => s + (Number(l.cents) || 0), 0); }
function quotePrompt(st: any) {
  const menu = (st.menu || []).slice(0, 6);
  const tot = st.lines.filter((l: any) => l.kind !== "optional").reduce((a: number, l: any) => a + (Number(l.cents) || 0), 0);
  return `Estimate so far:\n${st.lines.map((l: any) => `${l.kind === "optional" ? "(optional) " : ""}${l.desc}: ${money(l.cents)}`).join("\n") || "(nothing yet)"}\nTotal ${money(tot)}.${menu.length ? `\nFrom your price list, reply a number:\n${menu.map((x: any, i: number) => `${i + 1}. ${x.name}${x.cents != null ? " " + money(x.cents) : ""}`).join("\n")}` : ""}\nOr "add <what> <price>", "optional <what> <price>", "price <amount>", "discount <amount>".\nReply OK to send it.`;
}
function addonPrompt(st: any) {
  if (st.step === "quote") return quotePrompt(st);
  const menu = (st.menu || []).slice(0, 6);
  const m = menu.length ? `\nAdd-ons? Reply a number:\n${menu.map((x: any, i: number) => `${i + 1}. ${x.name}${x.cents != null ? " " + money(x.cents) : ""}`).join("\n")}\nor "add <what> <price>" (add filter 45).` : `\nAnything extra? Reply "add <what> <price>" (add filter 45).`;
  return `${linesSummary(st.lines)}\nTotal ${money(total(st.lines))}.${m}\nReply OK when it's right.`;
}

// Conversation layer. A tech types however he talks ("when's my next one", "tell her I'm 10 out", "bill it").
// Claude turns that into one of Donna's commands, answers from today's schedule, or asks ONE short question when
// something needed is missing (which job, how many minutes, what price). The last few turns are kept so answers
// to those questions land in context.
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const CMD_RE = /^(omw|on my way|otw|here|arrived|done|finished|finish|complete|completed|all done|wrapped up|wrapping up|bill it|invoice|late|running late|today|next|note|notes|help|\?|commands|menu|ok|okay|yes|no|send|later|hold|paid|got paid|they paid|cash|check|card|venmo|zelle|add|remove|discount|price|trip|cancel|nevermind|never mind|stop|move|reschedule|ack|got it|on it|taking it|quote|estimate|bid|schedule|optional|charge|run it|\d+)\b/;
async function interpret(text: string, jobs: any[], acct: any, tz: string, chat: any[], flow: string): Promise<{ command?: string; answer?: string; ask?: string } | null> {
  if (!ANTHROPIC_KEY) return null;
  const now = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date());
  const fmt = (iso: string) => { try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch { return ""; } };
  const list = jobs.map((j: any, i: number) => `#${i + 1} ${fmt(j.starts_at)} ${j.title} — ${j.customer_name || "no name"}${j.address ? ", " + j.address : ""} [${j.status}]${j.kind === "emergency" ? " (after-hours call)" : ""}`).join("\n") || "(nothing scheduled today)";
  const system = `You are Donna, the dispatcher/assistant for a small trade business, texting with one of its technicians. Reply with JSON only, one of:
{"command": "..."}  when the tech clearly wants you to DO something. Allowed commands (exact strings, fill the blanks): "omw <minutes>", "here", "done", "late <minutes>", "today", "next", "note <text>", "help", "send", "later", "paid cash", "paid check", "paid card", "add <what> <price>", "remove <what>", "discount <amount>", "price <amount>", "trip on", "trip off", "ok", "cancel", "charge" (run the customer's card on file for the invoice just built), "move <YYYY-MM-DD> <HH:MM>" (24h; moves the job to a new day/time), "cancel job" (cancels the job itself and tells the customer), "ack" (take the after-hours call you were paged for), "quote" (start an estimate for the current job; the tech supplies all prices), "optional <what> <price>" (an optional line while building an estimate), "schedule <EST-number> <YYYY-MM-DD> <HH:MM>" (book an approved estimate). Commands act on the current job (in progress, or the next one up). To aim at a different job from the list, append " #<n>" (e.g. "omw 10 #2").
{"answer": "..."}  (1-2 short friendly sentences, no markdown) when they ask a question you can answer from the schedule or the conversation: what's next, when, where, who, how many left, what's on the invoice so far.
{"ask": "..."}  ONE short question when they want an action but something needed is missing or ambiguous: which job (name the choices briefly), how many minutes, what price, what to add. Don't ask when a sensible default exists (no minutes given → "omw 0" is fine; "done" needs nothing).
Never invent jobs, prices, times or customers. Times are already in the shop's local time zone. If it's small talk or off-topic, give a one-line friendly answer and say what you can help with.`;
  const hist = (chat || []).slice(-8).map((m: any) => `${m.r === "t" ? "Tech" : "Donna"}: ${m.t}`).join("\n");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const user = `Business: ${acct.name}\nNow: ${now} (today is ${today}; "tomorrow" = the next calendar day)\nToday's jobs for this tech:\n${list}\n${flow ? `\nRight now: ${flow}\n` : ""}${hist ? `\nRecent conversation:\n${hist}\n` : ""}\nTech just texted: "${text}"`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 220, system, messages: [{ role: "user", content: user }] }) });
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => ({}));
    const t = String((j?.content || []).find((b: any) => b.type === "text")?.text || "").trim();
    const m = t.match(/\{[\s\S]*\}/); if (!m) return null;
    const out = JSON.parse(m[0]);
    if (out && typeof out.command === "string" && CMD_RE.test(out.command.toLowerCase().trim())) return { command: out.command.toLowerCase().trim() };
    if (out && typeof out.ask === "string" && out.ask.trim()) return { ask: out.ask.trim().slice(0, 300) };
    if (out && typeof out.answer === "string" && out.answer.trim()) return { answer: out.answer.trim().slice(0, 400) };
    return null;
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  // Callers: msg-inbound (service role), a cron/test caller with the shared secret, or a signed-in crew member (the phone app).
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let body: any = {}; try { body = await req.json(); } catch { return ok({ handled: false }); }
  let accountId = String(body.account_id || ""), userId = String(body.user_id || "");
  if (auth !== SERVICE_ROLE) {
    const { data: secretRow } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle();
    const cronSecret = (secretRow as any)?.value || "";
    if (!cronSecret || (req.headers.get("x-cron-secret") || "") !== cronSecret) {
      // Signed-in user: identity comes from the JWT, never from the body.
      const userClient = createClient(SUPA_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
      const { data: { user } } = await userClient.auth.getUser(auth);
      if (!user) return new Response(JSON.stringify({ handled: false, error: "forbidden" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
      const { data: me } = await supabase.from("users").select("id, account_id").eq("id", user.id).maybeSingle();
      if (!(me as any)?.account_id) return new Response(JSON.stringify({ handled: false, error: "forbidden" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
      userId = (me as any).id; accountId = (me as any).account_id;
    }
  }
  let text = String(body.body || "").trim(); const media: string[] = Array.isArray(body.media) ? body.media : [];
  if (!accountId || !userId) return ok({ handled: false });
  const { data: acct } = await supabase.from("accounts").select("id, name, settings, industry").eq("id", accountId).maybeSingle();
  if (!acct) return ok({ handled: false });
  const tz = acct.settings?.timezone || "America/Chicago";
  let low = text.toLowerCase().replace(/[.!]+$/, "").trim();
  const { data: sess } = await supabase.from("crew_sessions").select("state").eq("user_id", userId).maybeSingle();
  let st: any = (sess as any)?.state || {};
  const save = async (s: any) => { st = { ...s, chat: s.chat ?? st.chat }; await supabase.from("crew_sessions").upsert({ user_id: userId, account_id: accountId, state: st, updated_at: new Date().toISOString() }, { onConflict: "user_id" }); };
  const clear = () => save({});
  const todays = async () => { const r = await call("jobs", { action: "today", user_id: userId, mine: true }); return r?.jobs || []; };
  // Keep the last few turns so Donna can hold a short conversation (answers to her questions land in context).
  const pushChat = async (role: "t" | "d", t: string) => { const chat = [...(st.chat || []), { r: role, t: String(t).slice(0, 300) }].slice(-10); await save({ ...st, chat }); };
  const reply = async (r: string) => { await pushChat("d", r); return ok({ handled: true, reply: r }); };
  if (text) await pushChat("t", text);
  // "#2" on the end of a command aims it at job 2 on today's list instead of the current one.
  let forced = 0;
  const current = (jobs: any[]) => (forced && jobs[forced - 1]) ? jobs[forced - 1] : pickCurrent(jobs);
  const flowCtx = () => st.step === "quote" ? `writing an ESTIMATE for ${st.customer || "the customer"}: ${linesSummary(st.lines || [])}; the tech sets every price (add/optional/price/discount/remove), says ok to send, or cancel.` : st.step === "addons" ? `building the invoice for ${st.customer || "the customer"}: ${linesSummary(st.lines || [])} (total ${money(total(st.lines || []))}); add-on menu: ${(st.menu || []).map((x: any, i: number) => `${i + 1}. ${x.name}`).join(", ") || "none"}. Tech can add/remove lines, set a price or discount, toggle the trip fee, say ok to finish, or cancel.` : st.step === "send" ? `invoice ready for ${st.customer || "the customer"} (${money(st.total_cents || 0)}); waiting for: send, later, or paid (cash/check/card).` : "";

  async function dispatch(lowIn: string): Promise<Response | null> {
    let low = lowIn;
    const tag = low.match(/\s#(\d{1,2})$/); if (tag) { forced = parseInt(tag[1], 10); low = low.slice(0, tag.index).trim(); }


    // ---- Mid-flow states ----
    if ((st.step === "addons" || st.step === "quote") && st.job_id) {
      if (/^(cancel|nevermind|never mind|stop)$/.test(low)) { await clear(); return reply(st.step === "quote" ? "Okay, dropped that estimate." : "Okay, left it alone. Text DONE again when you're ready."); }
      if (st.step === "quote" && /^(ok|okay|k|yes|y|good|none|no|nope|that's it|thats it|right|correct|looks good|send)$/.test(low)) {
        // Estimate: Donna writes nothing herself; these are the tech's lines. Over the owner's review limit it waits for the owner.
        const lines = st.lines.filter((l: any) => !(l.kind === "trip_fee" && l.cents === 0));
        const cr = await call("estimates", { action: "create", user_id: userId, job_id: st.job_id, lines, notes: st.quote_notes || null });
        if (!cr?.ok) { await clear(); return reply("Couldn't save the estimate. Try from the app."); }
        await clear();
        if (cr.needs_review) return reply(`Estimate ${cr.estimate.number} for ${money(cr.estimate.total_cents)} is saved and waiting for the owner's okay (it's over the review limit). It goes out as soon as they approve it.`);
        const sr = await call("estimates", { action: "send", user_id: userId, id: cr.estimate.id });
        if (!sr?.ok) return reply(`Estimate ${cr.estimate.number} for ${money(cr.estimate.total_cents)} is saved, but I couldn't send it: ${sr?.message || "no phone or email"}. Send it from the app.`);
        return reply(`Sent estimate ${cr.estimate.number} for ${money(cr.estimate.total_cents)} to ${st.customer || "the customer"}${sr.sent?.sms ? " by text" : " by email"}. They tap Approve and I'll let you know.`);
      }
      const opt = st.step === "quote" ? low.match(/^(?:optional|if needed|maybe)\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s*$/) : null;
      if (opt) { st.lines.push({ desc: opt[1].replace(/\b\w/g, (c: string) => c.toUpperCase()), qty: 1, unit_cents: parseMoney(opt[2]) || 0, cents: parseMoney(opt[2]) || 0, kind: "optional" }); await save(st); return reply(quotePrompt(st)); }
      if (/^(ok|okay|k|yes|y|good|none|no|nope|that's it|thats it|right|correct|looks good|send)$/.test(low)) {
        const fin = await call("jobs", { action: "finalize", user_id: userId, job_id: st.job_id, lines: st.lines });
        if (!fin?.ok) { await clear(); return reply("Couldn't build the invoice. Open the app and try from there."); }
        let card: any = null; try { const { data: jr } = await supabase.from("jobs").select("card").eq("id", st.job_id).maybeSingle(); card = (jr as any)?.card?.payment_method ? (jr as any).card : null; } catch { /* */ }
        await save({ step: "send", job_id: st.job_id, invoice_id: fin.invoice.id, total_cents: fin.invoice.total_cents, customer: st.customer, phone: st.phone, card: !!card });
        return reply(`Invoice ${fin.invoice.number}: ${money(fin.invoice.total_cents)} for ${st.customer || "the customer"}.\n${card ? `They have a card on file (${card.brand || "card"} ${card.last4 ? "ending " + card.last4 : ""}). Reply CHARGE to run it, SEND to text them the invoice instead, LATER to hold it, or PAID if they paid another way.` : `Reply SEND to text it to them now, LATER to hold it, or PAID if they already paid you${st.online ? "" : " (cash/check)"}.`}`);
      }
      const nums = low.match(/^\s*(\d+(?:\s*[, ]\s*\d+)*)\s*$/);
      if (nums) {
        const picks = nums[1].split(/[, ]+/).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= (st.menu || []).length);
        if (!picks.length) return reply(`That number isn't on the list.\n${addonPrompt(st)}`);
        for (const n of picks) { const m = st.menu[n - 1]; st.lines.push({ desc: m.name, qty: 1, unit_cents: m.cents || 0, cents: m.cents || 0, kind: "addon" }); }
        await save(st); return reply(addonPrompt(st));
      }
      const add = low.match(/^(?:add|plus|\+)\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s*$/) || low.match(/^(?:add|plus|\+)\s+\$?(\d+(?:\.\d{1,2})?)\s+(?:for\s+)?(.+)$/);
      if (add) {
        const desc = /^\d/.test(add[1]) ? add[2] : add[1]; const cents = parseMoney(/^\d/.test(add[1]) ? add[1] : add[2]) || 0;
        st.lines.push({ desc: desc.replace(/\b\w/g, (c: string) => c.toUpperCase()), qty: 1, unit_cents: cents, cents, kind: "addon" }); await save(st); return reply(addonPrompt(st));
      }
      const rm = low.match(/^(?:remove|drop|delete|minus|-)\s+(.+)$/);
      if (rm) { const before = st.lines.length; st.lines = st.lines.filter((l: any, i: number) => !(String(l.desc).toLowerCase().includes(rm[1]) && i > 0 && l.kind !== "trip_fee")); await save(st); return reply(before === st.lines.length ? `Didn't find that line.\n${addonPrompt(st)}` : addonPrompt(st)); }
      const disc = low.match(/^(?:discount|off|take off)\s+\$?(\d+(?:\.\d{1,2})?)/);
      if (disc) { const c = parseMoney(disc[1]) || 0; st.lines.push({ desc: "Discount", qty: 1, unit_cents: c, cents: -c, kind: "discount" }); await save(st); return reply(addonPrompt(st)); }
      const price = low.match(/^(?:price|charge|total)\s+\$?(\d+(?:\.\d{1,2})?)/);
      if (price && st.lines[0]) { const c = parseMoney(price[1]) || 0; st.lines[0].cents = c; st.lines[0].unit_cents = c; st.lines[0].desc = String(st.lines[0].desc).replace(/ \(after hours\)$/, ""); delete st.lines[0].needs_price; await save(st); return reply(addonPrompt(st)); }
      const tf = low.match(/^(?:trip fee|trip)\s*(on|yes|charge|off|no|waive)?/);
      if (tf) { const t = st.lines.find((l: any) => l.kind === "trip_fee"); if (t) { const on = /on|yes|charge/.test(tf[1] || "on"); t.cents = on ? t.unit_cents : 0; t.desc = on ? "Trip fee" : "Trip fee (waived)"; await save(st); return reply(addonPrompt(st)); } }
      return null;
    }
    if (st.step === "send" && st.invoice_id) {
      if (/^(charge|charge it|run it|run the card|charge the card|charge card)$/.test(low)) {
        const { customer, total_cents } = st;
        const r = await call("payments", { action: "invoice_charge_card", user_id: userId, id: st.invoice_id });
        if (r?.ok) { await clear(); return reply(`Charged ${money(r.total_charged || total_cents)} to ${customer || "the customer"}'s card${r.last4 ? " ending " + r.last4 : ""}${r.card_fee_cents ? ` (includes the ${money(r.card_fee_cents)} card fee)` : ""}. Receipt sent. Nice work.`); }
        return reply(`${r?.message || "Couldn't charge the card."}\nReply SEND to text them the pay link, LATER to hold it, or PAID.`);
      }
      if (/^(send|send it|yes|y|ok|go)$/.test(low)) {
        const { customer, total_cents } = st;
        const r = await call("payments", { action: "invoice_send", user_id: userId, id: st.invoice_id });
        await clear();
        if (!r?.ok) return reply(r?.message || "Couldn't send it. The invoice is saved; send it from the app.");
        return reply(`Sent to ${customer || "the customer"}${r.sent?.sms ? " by text" : " by email"}: ${money(total_cents)}${r.online ? " with a Pay button" : ""}.${r.online ? " I'll text you when it's paid." : ""}`);
      }
      if (/^(later|hold|wait|not yet|no)$/.test(low)) { await clear(); return reply(`Holding it. It's under Jobs in the app whenever you want to send it.`); }
      const paid = low.match(/^(paid|got paid|they paid|cash|check|card|venmo|zelle)\b\s*(cash|check|card|venmo|zelle)?/);
      if (paid) {
        const how = (paid[2] || paid[1]); const method = /check/.test(how) ? "check" : /card/.test(how) ? "card" : /venmo|zelle/.test(how) ? "other" : "cash";
        const { total_cents } = st;
        const r = await call("payments", { action: "invoice_mark_paid", user_id: userId, id: st.invoice_id, method, note: /venmo|zelle/.test(how) ? how : null });
        await clear(); return reply(r?.ok ? `Marked paid (${/venmo|zelle/.test(how) ? how : method}), ${money(total_cents)}. Nice work.` : "Couldn't mark it paid. Try from the app.");
      }
      return null;
    }

    // ---- Photo by text: attach to the current job ----
    if (media.length) {
      const jobs = await todays(); const cur = current(jobs);
      if (!cur) return reply("Got the photo, but there's no job on your schedule today to pin it to.");
      const j = cur.job_id ? { ok: true, job: { id: cur.job_id } } : await call("jobs", { action: "job", user_id: userId, appointment_id: cur.appointment_id });
      if (j?.ok) { const { data: row } = await supabase.from("jobs").select("photos").eq("id", j.job.id).maybeSingle(); const photos = [...((row as any)?.photos || []), ...media.map((u) => ({ url: u, at: new Date().toISOString(), by: userId, caption: text || null }))]; await supabase.from("jobs").update({ photos, updated_at: new Date().toISOString() }).eq("id", j.job.id); }
      if (!text) return reply(`Saved ${media.length > 1 ? media.length + " photos" : "the photo"} to ${cur.title} for ${first(cur.customer_name)}.`);
    }

    // ---- Commands ----
    if (/^(help|\?|commands|menu)$/.test(low)) return reply(`Text me:\nOMW 20 - tell the customer you're on the way\nHERE - started\nDONE - finish up and bill\nLATE 15 - running behind\nTODAY - your jobs\nNEXT - next stop + map\nNOTE <text> - note on this job\nQUOTE - write an estimate (you set every price)\nMOVE 2026-11-12 15:00 - reschedule\nCANCEL JOB - cancel and tell the customer\nACK - take an after-hours call you were paged for\nSend a photo to save it to the job.\nOr just tell me what you need in your own words.`);

    if (/^(today|jobs|schedule|what's today|whats today|list)$/.test(low)) {
      const jobs = await todays(); if (!jobs.length) return reply("Nothing on the books today.");
      return reply(`Today:\n` + jobs.map((j: any, i: number) => `${i + 1}. ${fmtTime(j.starts_at, tz)} ${j.title} - ${j.customer_name || "walk-in"}${j.address ? ", " + j.address.split(",")[0] : ""}${j.status !== "scheduled" ? ` (${j.status.replace("_", " ")})` : ""}`).join("\n"));
    }
    if (/^(next|next job|where next|next stop)$/.test(low)) {
      const jobs = await todays(); const open = jobs.filter((j: any) => !["done", "invoiced", "paid", "cancelled"].includes(j.status)); const n = open[0];
      if (!n) return reply(jobs.length ? "That was your last one today." : "Nothing on the books today.");
      return reply(`Next: ${fmtTime(n.starts_at, tz)} ${n.title}\n${n.customer_name || ""}${n.customer_phone ? " " + n.customer_phone : ""}\n${n.address ? n.address + "\n" + mapLink(n.address) : "No address on file"}${n.notes ? "\nNotes: " + n.notes : ""}`);
    }

    const omw = low.match(/^(?:omw|otw|on my way|on the way|heading over|leaving now|en route)\b\s*(\d{1,3})?/);
    if (omw) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today to head to.");
      const r = await call("jobs", { action: "en_route", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined, minutes: omw[1] ? parseInt(omw[1], 10) : 0 });
      if (!r?.ok) return reply("Couldn't update that job.");
      return reply(`${r.texted ? `Told ${first(cur.customer_name)} you're on the way${omw[1] ? `, about ${omw[1]} min` : ""}.` : `Marked on the way (no mobile number to text for ${first(cur.customer_name)}).`}\n${cur.address ? cur.address + "\n" + mapLink(cur.address) : ""}`.trim());
    }
    if (/^(here|start|started|starting|arrived|on site|onsite)$/.test(low)) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today.");
      const r = await call("jobs", { action: "start", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
      return reply(r?.ok ? `Started ${cur.title} for ${first(cur.customer_name)}. Text DONE when you finish.` : "Couldn't update that job.");
    }
    const late = low.match(/^(?:late|running late|running behind|behind)\b\s*(\d{1,3})?\s*$/);
    if (late) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today.");
      const mins = late[1] ? parseInt(late[1], 10) : 15;
      const who = first(cur.customer_name);
      const r = await call("msg-send", { account_id: accountId, to: cur.customer_phone, body: `${acct.name}: running about ${mins} minutes behind for your ${cur.title.toLowerCase()} today. Sorry for the wait; reply here if that's a problem.` });
      return reply(r?.ok ? `Told ${who} you're about ${mins} minutes behind.` : `Couldn't text ${who} (no mobile number or texting is off).`);
    }
    const note = low.match(/^(?:note|notes)\s+(.+)/s);
    if (note) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job today to put that on.");
      const r = await call("jobs", { action: "note", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined, text: text.replace(/^notes?\s+/i, "") });
      return reply(r?.ok ? `Noted on ${cur.title} for ${first(cur.customer_name)}.` : "Couldn't save the note.");
    }
    if (/^(done|finished|finish|complete|completed|all done|wrapped up|wrapping up|bill it|invoice)$/.test(low)) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today to finish.");
      const r = await call("jobs", { action: "done", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
      if (!r?.ok) return reply("Couldn't close that job.");
      if (r.has_invoice) { const { data: inv } = await supabase.from("invoices").select("id, number, total_cents, status, paid_at").eq("id", r.job.invoice_id).maybeSingle(); if (inv && !inv.paid_at && inv.status !== "void") { await save({ step: "send", job_id: r.job.id, invoice_id: inv.id, total_cents: inv.total_cents, customer: cur.customer_name, phone: cur.customer_phone }); return reply(`${cur.title} for ${first(cur.customer_name)} already has invoice ${inv.number} (${money(inv.total_cents)}). Reply SEND, LATER, or PAID.`); } }
      const pa = await supabase.from("payment_accounts").select("charges_enabled").eq("account_id", accountId).maybeSingle();
      const online = acct.settings?.payments?.enabled === true && !!(pa.data as any)?.charges_enabled;
      await save({ step: "addons", job_id: r.job.id, lines: r.proposed, menu: r.menu, customer: cur.customer_name, phone: cur.customer_phone, online });
      const lead = r.proposed.some((l: any) => l.needs_price) ? `Finished ${cur.title} for ${first(cur.customer_name)}. I don't have a price for it; reply "price 150" to set it.\n` : `Finished ${cur.title} for ${first(cur.customer_name)}. Here's what I have:\n`;
      return reply(lead + addonPrompt(st));
    }

    // Estimate: "quote" starts one for the current job; the tech supplies every number.
    if (/^(quote|estimate|write (an? )?(estimate|quote)|bid)$/.test(low)) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today to estimate. Open the app to write one from scratch.");
      const r = await call("jobs", { action: "job", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
      if (!r?.ok) return reply("Couldn't open that job.");
      const lines = (r.proposed || []).filter((l: any) => l.kind !== "trip_fee" && l.kind !== "addon").map((l: any) => ({ ...l, cents: l.needs_price ? 0 : l.cents }));
      await save({ step: "quote", job_id: r.job.id, lines, menu: r.menu, customer: cur.customer_name, phone: cur.customer_phone });
      return reply(`Estimate for ${first(cur.customer_name)} (${cur.title}). Build it line by line; I don't set prices.\n` + quotePrompt(st));
    }
    const sch = low.match(/^schedule\s+(est-\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*$/);
    if (sch) {
      const { data: est } = await supabase.from("estimates").select("id, number, status").eq("account_id", accountId).ilike("number", sch[1]).maybeSingle();
      if (!est) return reply(`I don't see ${sch[1].toUpperCase()}.`);
      const r = await call("estimates", { action: "convert", user_id: userId, id: est.id, new_date: sch[2], new_time: sch[3] });
      if (!r?.ok) return reply(r?.message || "Couldn't schedule it.");
      return reply(`Booked ${est.number} for ${r.when_label}.${r.texted ? " Told the customer." : ""}`);
    }

    // Move a job: "move 2026-11-12 15:00" (Donna's interpreter turns "push Maria to 3 tomorrow" into this).
    const mv = low.match(/^(?:move|reschedule)\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*$/);
    if (mv) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today to move.");
      const r = await call("jobs", { action: "reschedule", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined, new_date: mv[1], new_time: mv[2] });
      if (!r?.ok) return reply(r?.message || "Couldn't move it.");
      return reply(`Moved ${cur.title} for ${first(cur.customer_name)} to ${r.when_label}.${r.texted ? " Told them by text." : ""}`);
    }
    if (/^(cancel (the )?job|cancel it|cancel (the )?(appointment|visit|call))$/.test(low)) {
      const jobs = await todays(); const cur = current(jobs); if (!cur) return reply("No job on your schedule today to cancel.");
      const r = await call("jobs", { action: "cancel", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
      return reply(r?.ok ? `Cancelled ${cur.title} for ${first(cur.customer_name)}.${r.texted ? " Told them by text." : ""}` : "Couldn't cancel it.");
    }
    // Acknowledge an after-hours page: stops the ladder, assigns the job to this tech.
    if (/^(ack|got it|on it|taking it|i('ll| will) take it|i got it)$/.test(low)) {
      const r = await call("oncall", { action: "ack", account_id: accountId, user_id: userId });
      if (!r?.ok) return reply("Nothing waiting to be acknowledged right now.");
      return reply("It's yours. Text OMW when you head out; the customer gets the heads-up.");
    }

    // Outside the Done flow: "paid cash" / "send" on a job that already has an open invoice.
    const paidTop = low.match(/^(?:paid|got paid|they paid)\b\s*(cash|check|card|venmo|zelle)?\s*$/);
    const sendTop = /^(send|send it|send the invoice|resend)$/.test(low);
    if (paidTop || sendTop) {
      const jobs = await todays(); const cur = current(jobs);
      let inv: any = null;
      if (cur?.invoice_id) { const { data } = await supabase.from("invoices").select("*").eq("id", cur.invoice_id).maybeSingle(); inv = data; }
      if (!inv || inv.paid_at || inv.status === "void") { const { data } = await supabase.from("invoices").select("*").eq("account_id", accountId).in("status", ["sent", "draft"]).order("created_at", { ascending: false }).limit(1).maybeSingle(); inv = data; }
      if (!inv) return reply("I don't see an open invoice to do that with. Text DONE on a job to bill it first.");
      if (paidTop) {
        const how = paidTop[1] || "cash"; const method = /check/.test(how) ? "check" : /card/.test(how) ? "card" : /venmo|zelle/.test(how) ? "other" : "cash";
        const r = await call("payments", { action: "invoice_mark_paid", user_id: userId, id: inv.id, method, note: /venmo|zelle/.test(how) ? how : null });
        return reply(r?.ok ? `Marked ${inv.number} paid (${how}), ${money(inv.total_cents)} from ${inv.customer_name || "the customer"}. I've sent them a receipt.` : "Couldn't mark it paid. Try from the app.");
      }
      const r = await call("payments", { action: "invoice_send", user_id: userId, id: inv.id });
      return reply(r?.ok ? `Sent ${inv.number} (${money(inv.total_cents)}) to ${inv.customer_name || "the customer"}${r.online ? " with a Pay button" : ""}.` : (r?.message || "Couldn't send it."));
    }

    return null;
  }

  // 1) Try it as a command. 2) Otherwise let Donna interpret it (unless it's an obvious command that just failed).
  let out = await dispatch(low);
  if (!out) {
    const jobs = await todays();
    const it = await interpret(text, jobs, acct, tz, st.chat || [], flowCtx());
    if (it?.command) { if (/^notes?\s/.test(it.command)) text = it.command; out = await dispatch(it.command); }
    if (!out && it?.ask) out = await reply(it.ask);
    if (!out && it?.answer) out = await reply(it.answer);
  }
  if (!out) {
    if (st.step === "addons" || st.step === "quote") out = await reply(`Didn't catch that.\n${addonPrompt(st)}`);
    else if (st.step === "send") out = await reply(st.card ? `Reply CHARGE (card on file), SEND, LATER, or PAID.` : `Reply SEND, LATER, or PAID.`);
    else return ok({ handled: false });
  }
  return out;
});
