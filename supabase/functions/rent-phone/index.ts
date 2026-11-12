import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Donna on the phone: "how much is my rent / what do I owe?" (Retell custom tool `rent_balance`).
//
// Who may hear a balance (Hubert, Nov 12 2026):
//   1. The call comes from the phone number on the lease -> Donna says the amount and due date and texts the pay link.
//   2. Any other number -> Donna says nothing about the account. She can text a 6-digit code to the phone ON FILE;
//      when the caller reads it back, she continues. Codes last 10 minutes, 3 tries, 3 codes an hour per caller.
//   3. She only ever gives the amount, the due date, whether autopay is on, and a pay link sent to the phone on file.
//      Never the address back to an unverified caller, never payment details, never card or bank numbers by phone.
//
// Tool arguments: { name?: tenant's name as they said it, code?: the 6 digits they read back }.

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = "https://hingbdtmxozbjetzwibj.supabase.co/functions/v1";
const APP = "https://donna-dashboard-three.vercel.app";
const RETELL_WEBHOOK_SECRET = Deno.env.get("RETELL_WEBHOOK_SECRET") || "";
const RETELL_SIG_ENFORCE = (Deno.env.get("RETELL_SIG_ENFORCE") || "").toLowerCase() === "true";
const supabase = createClient(SUPA_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const money = (c: number) => `$${(Math.round(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const normPhone = (p: string) => { let d = String(p || "").replace(/[^\d+]/g, ""); if (/^\d{10}$/.test(d)) d = "+1" + d; if (/^1\d{10}$/.test(d)) d = "+" + d; return /^\+1\d{10}$/.test(d) ? d : ""; };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const sayDate = (d: string) => d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}` : "";
const payUrl = (t: string) => `${APP}/pay/${t}`;
const nowIso = () => new Date().toISOString();

async function retellSigValid(raw: string, sig: string | null): Promise<boolean> {
  if (!RETELL_WEBHOOK_SECRET || !sig) return false;
  const m = String(sig).match(/v=(\d+),d=(.*)/); if (!m) return false;
  if (Math.abs(Date.now() - Number(m[1])) > 5 * 60 * 1000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(RETELL_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw + m[1]));
    const exp = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join(""); const got = (m[2] || "").trim().toLowerCase();
    if (exp.length !== got.length) return false; let d = 0; for (let i = 0; i < exp.length; i++) d |= exp.charCodeAt(i) ^ got.charCodeAt(i); return d === 0;
  } catch { return false; }
}
async function sha(s: string): Promise<string> { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join(""); }
async function sendText(accountId: string, to: string, body: string): Promise<boolean> {
  const num = normPhone(to); if (!num) return false;
  try { const r = await fetch(`${SELF}/msg-send`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` }, body: JSON.stringify({ account_id: accountId, to: num, body }) }); const j: any = await r.json().catch(() => ({})); return !!j?.ok; } catch { return false; }
}
const words = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1);

// What Donna may say once the caller is verified for these leases. The pay link goes to the phone on file, never to the caller's number.
async function balanceFor(acct: any, leases: any[]): Promise<string> {
  const ids = leases.map((l) => l.id); const byId: Record<string, any> = {}; for (const l of leases) byId[l.id] = l;
  const { data: open } = await supabase.from("invoices").select("id, lease_id, total_cents, due_at, pay_token, late_fee_applied_at").in("lease_id", ids).eq("kind", "rent").in("status", ["draft", "sent"]).order("due_at");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: acct?.settings?.timezone || "America/Chicago" }).format(new Date());
  const items: any[] = [];
  for (const i of open || []) {
    const { data: pays } = await supabase.from("payments").select("amount_cents").eq("invoice_id", (i as any).id);
    const { data: proc } = await supabase.from("rent_sessions").select("amount_cents").eq("invoice_id", (i as any).id).eq("status", "processing");
    const paid = (pays || []).reduce((t: number, p: any) => t + p.amount_cents, 0); const clearing = (proc || []).reduce((t: number, p: any) => t + p.amount_cents, 0);
    items.push({ ...(i as any), lease: byId[(i as any).lease_id], owed: Math.max(0, (i as any).total_cents - paid - clearing), clearing });
  }
  const due = items.filter((i) => i.owed > 0); const clearing = items.reduce((t, i) => t + i.clearing, 0);
  const anyAuto = leases.some((l) => l.autopay?.payment_method); const blocked = leases.some((l) => l.block_payments);
  if (blocked) return "I'm not able to go over this account by phone. Please call the office directly, or I can take a message for the manager.";
  if (!due.length) return `You're all paid up; nothing is due right now.${clearing ? ` A payment of ${money(clearing)} is still clearing with the bank.` : ""}${anyAuto ? " Autopay is on, so your next rent will be drawn on the due date." : ""}`;
  const one = new Set(due.map((i) => i.lease_id)).size === 1; const total = due.reduce((t, i) => t + i.owed, 0);
  const parts = due.slice(0, 3).map((i) => `${money(i.owed)}${one ? "" : ` for ${i.lease.label}`} ${i.due_at < today ? `that was due ${sayDate(i.due_at)}${i.late_fee_applied_at ? ", including a late fee" : ""}` : `due ${sayDate(i.due_at)}`}${i.lease.autopay?.payment_method && i.due_at >= today ? ", which autopay will draw on the due date" : ""}`);
  if (due.length > 1) parts[parts.length - 1] += `, so ${money(total)} in all`;
  const phone = leases.find((l) => l.tenant_phone)?.tenant_phone || "";
  const sms = `${acct.name} rent:\n${due.slice(0, 3).map((i) => `${i.lease.label}: ${money(i.owed)} due ${sayDate(i.due_at)} ${payUrl(i.pay_token)}`).join("\n")}`;
  const sent = phone && acct?.settings?.sms?.enabled === true ? await sendText(acct.id, phone, sms) : false;
  return `You owe ${parts.join("; and ")}.${clearing ? ` That already leaves out ${money(clearing)} that is still clearing.` : ""} ${sent ? "I just texted the pay link to the phone number on your lease." : "You can pay with the link on your rent notice."} I can't take card or bank numbers over the phone.`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const raw = await req.text(); let body: any = {}; try { body = JSON.parse(raw || "{}"); } catch { return json({ error: "bad_json" }, 400); }
  // Two callers: Retell (signed tool call) or an internal test (x-cron-secret, with to_number / from_number in the body).
  let internal = false;
  if (req.headers.get("x-cron-secret")) { const { data: sec } = await supabase.from("app_secrets").select("value").eq("key", "cron_secret").maybeSingle(); internal = !!(sec as any)?.value && req.headers.get("x-cron-secret") === (sec as any).value; }
  if (!internal) { const valid = await retellSigValid(raw, req.headers.get("x-retell-signature")); console.log(`retell-sig rent-phone: ${valid ? "PASS" : "FAIL"}`); if (!valid && RETELL_SIG_ENFORCE) return json({ error: "unauthorized" }, 401); if (!body?.call) return json({ error: "unauthorized" }, 401); }
  const call = body.call || {}; const args = body.args || body.arguments || body || {}; const outbound = call.direction === "outbound";
  const donnaNum = outbound ? call.from_number : call.to_number; const caller = normPhone(outbound ? call.to_number : call.from_number);
  const oops = "I'm having trouble looking up rent right now. I can take a message for the manager.";
  let accountId = internal && body.account_id ? String(body.account_id) : "";
  if (!accountId) { const { data: asst } = await supabase.from("assistants").select("account_id").eq("twilio_number", donnaNum).maybeSingle(); accountId = (asst as any)?.account_id || ""; }
  if (!accountId) return json({ result: oops });
  const { data: acct } = await supabase.from("accounts").select("id, name, settings").eq("id", accountId).maybeSingle(); if (!acct) return json({ result: oops });
  const { data: all } = await supabase.from("leases").select("id, tenant_name, tenant_phone, label, autopay, block_payments").eq("account_id", accountId).eq("status", "active");
  const leases = all || [];
  const noMatch = "I can't verify this account from the number you're calling from, so I can't go over a balance. I can take a message for the manager, and they can verify you and send a statement.";

  // 1. Calling from the phone on the lease.
  const mine = caller ? leases.filter((l: any) => normPhone(l.tenant_phone || "") === caller) : [];
  if (mine.length) return json({ result: await balanceFor(acct, mine) });

  // 2. They read back a code.
  const code = String(args.code || "").replace(/\D/g, "");
  if (code) {
    if (!caller) return json({ result: noMatch });
    const { data: rows } = await supabase.from("rent_phone_codes").select("*").eq("account_id", accountId).eq("caller", caller).is("used_at", null).gt("expires_at", nowIso()).order("created_at", { ascending: false }).limit(1);
    const row: any = (rows || [])[0];
    if (!row) return json({ result: "That code has expired or I don't have one for this call. I can text a new one to the phone on file if you tell me the name on the lease." });
    if (row.attempts >= 3) return json({ result: "That code has been tried too many times. I can take a message for the manager." });
    if ((await sha(`${row.id}:${code}`)) !== row.code_hash) { await supabase.from("rent_phone_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id); return json({ result: "That code doesn't match. Please read me the 6 digits from the text once more." }); }
    await supabase.from("rent_phone_codes").update({ used_at: nowIso() }).eq("id", row.id);
    const l = leases.find((x: any) => x.id === row.lease_id); if (!l) return json({ result: noMatch });
    return json({ result: `Thank you, you're verified. ${await balanceFor(acct, [l])}` });
  }

  // 3. Unknown number, no code yet: text a code to the phone on file for the name they gave. Never confirm whether a lease exists.
  const name = String(args.name || "").trim();
  if (!name) return json({ result: "I don't see a lease under the number you're calling from. What is the full name on the lease? I can text a security code to the phone number we have on file." });
  if (!caller) return json({ result: noMatch });
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count } = await supabase.from("rent_phone_codes").select("id", { count: "exact", head: true }).eq("account_id", accountId).eq("caller", caller).gte("created_at", since);
  if ((count || 0) >= 3) return json({ result: "I've already sent the most codes I can for now. I can take a message for the manager." });
  const want = words(name);
  const hits = leases.filter((l: any) => { const have = words(l.tenant_name); return want.length >= 2 && want.every((w) => have.includes(w)); });
  const neutral = "If that matches our records, I just texted a 6-digit code to the phone number on the lease. Read it to me when it arrives. If nothing comes in a minute, I can take a message for the manager.";
  if (hits.length !== 1 || !normPhone(hits[0].tenant_phone || "") || (acct as any).settings?.sms?.enabled !== true) return json({ result: neutral });
  const digits = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  const { data: row } = await supabase.from("rent_phone_codes").insert({ account_id: accountId, lease_id: hits[0].id, caller, code_hash: "pending", expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }).select("id").maybeSingle();
  if (!(row as any)?.id) return json({ result: neutral });
  await supabase.from("rent_phone_codes").update({ code_hash: await sha(`${(row as any).id}:${digits}`) }).eq("id", (row as any).id);
  await sendText(accountId, hits[0].tenant_phone, `${(acct as any).name}: your security code is ${digits}. Someone asked about your rent by phone. Only share this code if that was you. It expires in 10 minutes.`);
  return json({ result: neutral });
});
