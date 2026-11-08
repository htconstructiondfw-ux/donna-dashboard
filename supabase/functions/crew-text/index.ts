import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna crew-text (v2): the contractor runs his day by texting Donna's number from his own phone.
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
function addonPrompt(st: any) {
  const menu = (st.menu || []).slice(0, 6);
  const m = menu.length ? `\nAdd-ons? Reply a number:\n${menu.map((x: any, i: number) => `${i + 1}. ${x.name}${x.cents != null ? " " + money(x.cents) : ""}`).join("\n")}\nor "add <what> <price>" (add filter 45).` : `\nAnything extra? Reply "add <what> <price>" (add filter 45).`;
  return `${linesSummary(st.lines)}\nTotal ${money(total(st.lines))}.${m}\nReply OK when it's right.`;
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
  const text = String(body.body || "").trim(); const media: string[] = Array.isArray(body.media) ? body.media : [];
  if (!accountId || !userId) return ok({ handled: false });
  const { data: acct } = await supabase.from("accounts").select("id, name, settings, industry").eq("id", accountId).maybeSingle();
  if (!acct) return ok({ handled: false });
  const tz = acct.settings?.timezone || "America/Chicago";
  const low = text.toLowerCase().replace(/[.!]+$/, "").trim();
  const { data: sess } = await supabase.from("crew_sessions").select("state").eq("user_id", userId).maybeSingle();
  let st: any = (sess as any)?.state || {};
  const save = async (s: any) => { st = s; await supabase.from("crew_sessions").upsert({ user_id: userId, account_id: accountId, state: s, updated_at: new Date().toISOString() }, { onConflict: "user_id" }); };
  const clear = () => save({});
  const todays = async () => { const r = await call("jobs", { action: "today", user_id: userId, mine: true }); return r?.jobs || []; };
  const reply = (r: string) => ok({ handled: true, reply: r });

  // ---- Mid-flow states ----
  if (st.step === "addons" && st.job_id) {
    if (/^(cancel|nevermind|never mind|stop)$/.test(low)) { await clear(); return reply("Okay, left it alone. Text DONE again when you're ready."); }
    if (/^(ok|okay|k|yes|y|good|none|no|nope|that's it|thats it|right|correct|looks good|send)$/.test(low)) {
      const fin = await call("jobs", { action: "finalize", user_id: userId, job_id: st.job_id, lines: st.lines });
      if (!fin?.ok) { await clear(); return reply("Couldn't build the invoice. Open the app and try from there."); }
      await save({ step: "send", job_id: st.job_id, invoice_id: fin.invoice.id, total_cents: fin.invoice.total_cents, customer: st.customer, phone: st.phone });
      return reply(`Invoice ${fin.invoice.number}: ${money(fin.invoice.total_cents)} for ${st.customer || "the customer"}.\nReply SEND to text it to them now, LATER to hold it, or PAID if they already paid you${st.online ? "" : " (cash/check)"}.`);
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
    return reply(`Didn't catch that.\n${addonPrompt(st)}`);
  }
  if (st.step === "send" && st.invoice_id) {
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
    return reply(`Reply SEND, LATER, or PAID.`);
  }

  // ---- Photo by text: attach to the current job ----
  if (media.length) {
    const jobs = await todays(); const cur = pickCurrent(jobs);
    if (!cur) return reply("Got the photo, but there's no job on your schedule today to pin it to.");
    const j = cur.job_id ? { ok: true, job: { id: cur.job_id } } : await call("jobs", { action: "job", user_id: userId, appointment_id: cur.appointment_id });
    if (j?.ok) { const { data: row } = await supabase.from("jobs").select("photos").eq("id", j.job.id).maybeSingle(); const photos = [...((row as any)?.photos || []), ...media.map((u) => ({ url: u, at: new Date().toISOString(), by: userId, caption: text || null }))]; await supabase.from("jobs").update({ photos, updated_at: new Date().toISOString() }).eq("id", j.job.id); }
    if (!text) return reply(`Saved ${media.length > 1 ? media.length + " photos" : "the photo"} to ${cur.title} for ${first(cur.customer_name)}.`);
  }

  // ---- Commands ----
  if (/^(help|\?|commands|menu)$/.test(low)) return reply(`Text me:\nOMW 20 - tell the customer you're on the way\nHERE - started\nDONE - finish up and bill\nLATE 15 - running behind\nTODAY - your jobs\nNEXT - next stop + map\nNOTE <text> - note on this job\nSend a photo to save it to the job.`);

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
    const jobs = await todays(); const cur = pickCurrent(jobs); if (!cur) return reply("No job on your schedule today to head to.");
    const r = await call("jobs", { action: "en_route", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined, minutes: omw[1] ? parseInt(omw[1], 10) : 0 });
    if (!r?.ok) return reply("Couldn't update that job.");
    return reply(`${r.texted ? `Told ${first(cur.customer_name)} you're on the way${omw[1] ? `, about ${omw[1]} min` : ""}.` : `Marked on the way (no mobile number to text for ${first(cur.customer_name)}).`}\n${cur.address ? cur.address + "\n" + mapLink(cur.address) : ""}`.trim());
  }
  if (/^(here|start|started|starting|arrived|on site|onsite)$/.test(low)) {
    const jobs = await todays(); const cur = pickCurrent(jobs); if (!cur) return reply("No job on your schedule today.");
    const r = await call("jobs", { action: "start", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
    return reply(r?.ok ? `Started ${cur.title} for ${first(cur.customer_name)}. Text DONE when you finish.` : "Couldn't update that job.");
  }
  const late = low.match(/^(?:late|running late|running behind|behind)\s*(\d{1,3})?/);
  if (late) {
    const jobs = await todays(); const cur = pickCurrent(jobs); if (!cur) return reply("No job on your schedule today.");
    const mins = late[1] ? parseInt(late[1], 10) : 15;
    const who = first(cur.customer_name);
    const r = await call("msg-send", { account_id: accountId, to: cur.customer_phone, body: `${acct.name}: running about ${mins} minutes behind for your ${cur.title.toLowerCase()} today. Sorry for the wait; reply here if that's a problem.` });
    return reply(r?.ok ? `Told ${who} you're about ${mins} minutes behind.` : `Couldn't text ${who} (no mobile number or texting is off).`);
  }
  const note = low.match(/^(?:note|notes)\s+(.+)/s);
  if (note) {
    const jobs = await todays(); const cur = pickCurrent(jobs); if (!cur) return reply("No job today to put that on.");
    const r = await call("jobs", { action: "note", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined, text: text.replace(/^notes?\s+/i, "") });
    return reply(r?.ok ? `Noted on ${cur.title} for ${first(cur.customer_name)}.` : "Couldn't save the note.");
  }
  if (/^(done|finished|finish|complete|completed|all done|wrapped up|wrapping up|bill it|invoice)$/.test(low)) {
    const jobs = await todays(); const cur = pickCurrent(jobs); if (!cur) return reply("No job on your schedule today to finish.");
    const r = await call("jobs", { action: "done", user_id: userId, appointment_id: cur.appointment_id, job_id: cur.job_id || undefined });
    if (!r?.ok) return reply("Couldn't close that job.");
    if (r.has_invoice) { const { data: inv } = await supabase.from("invoices").select("id, number, total_cents, status, paid_at").eq("id", r.job.invoice_id).maybeSingle(); if (inv && !inv.paid_at && inv.status !== "void") { await save({ step: "send", job_id: r.job.id, invoice_id: inv.id, total_cents: inv.total_cents, customer: cur.customer_name, phone: cur.customer_phone }); return reply(`${cur.title} for ${first(cur.customer_name)} already has invoice ${inv.number} (${money(inv.total_cents)}). Reply SEND, LATER, or PAID.`); } }
    const pa = await supabase.from("payment_accounts").select("charges_enabled").eq("account_id", accountId).maybeSingle();
    const online = acct.settings?.payments?.enabled === true && !!(pa.data as any)?.charges_enabled;
    await save({ step: "addons", job_id: r.job.id, lines: r.proposed, menu: r.menu, customer: cur.customer_name, phone: cur.customer_phone, online });
    const lead = r.proposed.some((l: any) => l.needs_price) ? `Finished ${cur.title} for ${first(cur.customer_name)}. I don't have a price for it; reply "price 150" to set it.\n` : `Finished ${cur.title} for ${first(cur.customer_name)}. Here's what I have:\n`;
    return reply(lead + addonPrompt(st));
  }

  return ok({ handled: false });
});
