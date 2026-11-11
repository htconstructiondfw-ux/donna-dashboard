# Builds the customer-facing Donna pricing and comparison packet (donna-pricing.html -> PDF via ../render.js).
import html
E=html.escape
IND=[
 dict(key='general',name='Everyday businesses',who='Cleaners, detailers, tutors, trainers, studios, repair shops and offices',c='#2f6f4f',deep='#123326',hi='#7fd3a6',
  lead='Priced right with the cheapest AI answering services, but Donna books, texts and follows up instead of just taking a message.',
  them='Typical AI answering service',them_eg='e.g. Rosie, Goodcall',them_price='$49–249',
  stat=('Same price,','more included','Booking, texting and a team plan come standard.'),
  rows=[('Minutes included','250 at $49, then 25¢/min','300, then 25¢/min','1,000, then 20¢/min'),
   ('Every call answered 24/7','Y','Y','Y'),('Books appointments into a calendar','Higher plans only','Y','Y'),
   ('Text confirmations and reminders','Booking links on entry plans','Y','Y'),('Email inbox answered','Varies','Y','Y'),
   ('25 languages','Varies','Y','Y'),('Logins','Varies','One person','Unlimited team')],
  win='More minutes than the leading AI answerer at the same $49, booking included from the first plan, and a team plan with no per-user fee.',
  s=('$49','300 min'),p=('$149','1,000 min')),
 dict(key='salon',name='Salons and spas',who='Hair, barber, nail, lash, spa and med-spa',c='#8a3a5c',deep='#3b1426',hi='#f2a7c3',
  lead='Most salons pay twice: booking software, then an AI phone add-on on top. Donna is both, for one bill.',
  them='Typical salon stack',them_eg='booking software + AI phone add-on',them_price='$75–300+',
  stat=('One bill','instead of two','Booking, phone, texts and checkout together.'),
  rows=[('Minutes included','AI often billed 50–60¢/min','400, then 25¢/min','1,200, then 20¢/min'),
   ('Texts','Some charge per text','Included','Included'),('Bills to manage','Two','One','One'),
   ('Online booking and calendar','Y','Y','Y'),('AI phone answering','Paid add-on','Included','Included'),
   ('Waitlist that fills cancellations','Varies','Y','Y'),('Rebooking reminders and review asks','Varies','Y','Y'),
   ('Checkout, tips and gift cards','Y','Y','Y'),('Stylists','Often a fee per stylist','One stylist','Unlimited, each with their own calendar')],
  win='One bill instead of two, no per-text charges, and extra minutes at 25¢ instead of 50–60¢. Every stylist gets a login and their own book on Pro at no extra cost.',
  s=('$79','400 min'),p=('$199','1,200 min')),
 dict(key='contractor',name='Contractors and the trades',who='HVAC, plumbing, electrical, lawn, pool, roofing and handyman',c='#c2561a',deep='#1d2733',hi='#ffb27a',
  lead='Field-service apps sell software with the phone bolted on. Donna is the receptionist first, with jobs, estimates, invoices and the tech app included.',
  them='Typical field-service stack',them_eg='e.g. Jobber Grow + AI Receptionist',them_price='about $230–330',
  stat=('No','per-tech fees','Your whole crew on one flat price.'),
  rows=[('Minutes included','AI conversations capped on lower tiers','500, then 25¢/min','1,500, then 20¢/min'),
   ('Techs','Team tiers cost more (e.g. $199 to $299/mo)','One','Unlimited'),
   ('Phone answered 24/7 and jobs booked','AI add-on, books inside the app','Y','Y'),
   ('After-hours emergencies paged and escalated','Varies','Y','Y'),('Estimates with an approve link','Y','Y','Y'),
   ('Invoices and card payments','Through their processing','Into your own Stripe','Into your own Stripe'),
   ('Run the day by text or one phone app','App','Y','Y'),('Dispatch by trade and zip','Higher plans','Not needed solo','Y')],
  win='A one-truck shop pays $149 on Donna Starter instead of about $230. As the crew grows, typical stacks jump to a team tier around $330; Donna Pro stays $349 for unlimited techs, with every call answered, no annual contract, and payments to your own Stripe at Stripe\'s rates.',
  s=('$149','500 min'),p=('$349','1,500 min')),
 dict(key='pm',name='Property management',who='Residential rentals, commercial and flex buildings, HOAs and condos',c='#24538a',deep='#0f2440',hi='#8cc2ff',
  lead='Donna works alongside your accounting and lease software. She replaces the answering service and the leasing and maintenance phone work, at a flat price no matter how many doors.',
  them='Typical answering service',them_eg='after-hours and overflow',them_price='$200–500',
  stat=('Flat price,','any number of doors','The portfolio grows; the bill doesn\'t.'),
  rows=[('Minutes included','Often 50–100, then $2–5/min','500, then 25¢/min','1,500, then 20¢/min'),
   ('Every call answered 24/7','Y','Y','Y'),('Emergencies paged, confirmed and escalated','Message relayed','Y','Y'),
   ('Work orders logged with unit, access and photos','N','Y','Y'),('Same answers by phone, email and text','Phone only','Y','Y'),
   ('Showings and inspections booked at the unit','N','Y','Y'),('HOA: ARC requests, violations, amenities','N','Y','Y'),
   ('HOA dues collection with autopay','N','Y','Y'),('Owner and board one-tap approvals','N','Y','Y'),
   ('Logins','One account','One manager','Unlimited managers')],
  win='Starter costs less than most answering services and does the follow-through they leave to you. Pro adds your whole team for a price that stays flat as the portfolio grows.',
  s=('$149','500 min'),p=('$349','1,500 min')),
 dict(key='re',name='Real estate',who='Agents, teams, brokers and the rentals you manage',c='#0f6e6a',deep='#0b2f33',hi='#7fe0d6',
  lead='Real estate AI tools usually charge per agent. Donna charges once for the whole office.',
  them='Typical per-seat AI and CRM tools',them_eg='priced per agent',them_price='$299–1,000+ per agent',
  stat=('About ¼','the cost for a 5-agent office','$349 total instead of $1,500 or more.'),
  rows=[('Agents covered','One per seat','One agent','The whole office'),
   ('Minutes included','Varies','500, then 25¢/min','1,500, then 20¢/min'),
   ('Listing questions answered 24/7','Varies','Y','Y'),('Showings booked, agreement texted for e-signature','Varies','Y','Y'),
   ('Hot leads texted to the right agent','Y','Y','Y'),('Fair Housing-safe answers','Varies','Y','Y'),
   ('Managed rentals and maintenance calls','Rarely','Y','Y')],
  win='A 5-agent office pays about a quarter of a per-seat stack, and every agent\'s showings land on their own calendar.',
  s=('$149','500 min'),p=('$349','1,500 min')),
]
def cell(v,ours=False):
    if v=='Y': return '<span class="ck">✓</span>' if ours else '<span class="ck dim">✓</span>'
    if v=='N': return '<span class="no">—</span>'
    return ('<b>%s</b>' if ours else '%s')%E(v)
def ipage(d,n):
    rows=''.join(f'<tr><th>{E(r[0])}</th><td class="them">{cell(r[1])}</td><td class="us">{cell(r[2],1)}</td><td class="us pro">{cell(r[3],1)}</td></tr>' for r in d['rows'])
    return f'''<section class="page ind" style="--c:{d['c']};--deep:{d['deep']};--hi:{d['hi']}">
  <div class="ihead"><div><div class="kick">Donna for</div><h2>{E(d['name'])}</h2><div class="who">{E(d['who'])}</div></div>
   <div class="big"><b>{E(d['stat'][0])}</b><span>{E(d['stat'][1])}</span><small>{E(d['stat'][2])}</small></div></div>
  <p class="lead">{E(d['lead'])}</p>
  <table class="cmp">
   <thead><tr><th></th><th class="them"><span class="lbl">{E(d['them'])}</span><span class="eg">{E(d['them_eg'])}</span></th><th class="us"><span class="lbl">Donna Starter</span><span class="eg">one person</span></th><th class="us pro"><span class="tagp">Best value for teams</span><span class="lbl">Donna Pro</span><span class="eg">unlimited team</span></th></tr>
   <tr class="price"><th>Monthly price</th><td class="them">{E(d['them_price'])}</td><td class="us"><b>{d['s'][0]}</b><small>/mo</small></td><td class="us pro"><b>{d['p'][0]}</b><small>/mo</small></td></tr></thead>
   <tbody>{rows}</tbody>
  </table>
  <div class="win"><div class="wk">Why Donna wins</div>{E(d['win'])}</div>
  <div class="foot"><span>Competitor figures are typical public list prices, rounded, as of November 2026; your costs may differ.</span><span>{n}</span></div>
</section>'''
glance=''.join(f'<tr style="--c:{d["c"]}"><th><i></i>{E(d["name"])}</th><td><b>{d["s"][0]}</b> · {d["s"][1]}</td><td><b>{d["p"][0]}</b> · {d["p"][1]}{", any number of doors" if d["key"]=="pm" else (", whole office" if d["key"]=="re" else "")}</td></tr>' for d in IND)
pages=''.join(ipage(d,i+3) for i,d in enumerate(IND))
out=f'''<!doctype html><html><head><meta charset="utf-8"><title>Donna pricing</title><style>
@page{{size:Letter;margin:0}}
*{{box-sizing:border-box}} body{{margin:0;font-family:"Inter",Helvetica,Arial,sans-serif;color:#18212b;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.page{{width:8.5in;height:11in;position:relative;overflow:hidden;padding:.6in .65in .55in;page-break-after:always;background:#fbfaf7}}
h1,h2,.big b,.pnum{{font-family:"Inter Display","Inter",sans-serif;letter-spacing:-.025em}}
.foot{{position:absolute;left:.65in;right:.65in;bottom:.32in;display:flex;justify-content:space-between;font-size:9px;color:#8a929b}}
/* cover */
.cover{{background:#101a24;color:#fff;padding:0}}
.cover .bg{{position:absolute;inset:0;background:radial-gradient(60% 45% at 90% 8%,rgba(47,111,79,.55),transparent 60%),radial-gradient(45% 40% at 5% 45%,rgba(138,58,92,.45),transparent 60%),radial-gradient(50% 40% at 95% 70%,rgba(36,83,138,.5),transparent 60%),radial-gradient(45% 35% at 20% 100%,rgba(194,86,26,.45),transparent 60%)}}
.cover .dots{{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.06) 1.1px,transparent 1.2px);background-size:18px 18px}}
.cover .in{{position:relative;padding:.6in .65in}}
.logo{{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px}}
.logo .mk{{width:34px;height:34px;border-radius:10px;background:#fff;color:#101a24;display:flex;align-items:center;justify-content:center;font-family:"Inter Display";font-weight:800;font-size:19px}}
.logo small{{display:block;font-size:10.5px;font-weight:500;opacity:.65;letter-spacing:.06em;text-transform:uppercase}}
.cover h1{{font-size:50px;line-height:1.02;font-weight:800;margin:.55in 0 14px;max-width:6.6in}}
.cover h1 em{{font-style:normal;color:#7fd3a6}}
.cover .sub{{font-size:15.5px;line-height:1.55;opacity:.88;max-width:6.3in;margin:0}}
.glance{{margin-top:.38in;background:#fff;color:#18212b;border-radius:18px;padding:16px 20px 10px;box-shadow:0 24px 60px rgba(0,0,0,.4)}}
.glance h3{{margin:0 0 8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7580}}
.glance table{{width:100%;border-collapse:collapse;font-size:13px}}
.glance th,.glance td{{text-align:left;padding:9px 6px;border-top:1px solid #eceae4}}
.glance thead th{{border-top:none;font-size:10.5px;color:#6b7580;font-weight:600;padding-top:0}}
.glance tbody th{{font-weight:600}}
.glance tbody th i{{display:inline-block;width:9px;height:9px;border-radius:3px;background:var(--c);margin-right:9px}}
.glance td b{{font-family:"Inter Display";font-size:16px}}
.glance .note{{font-size:11px;color:#6b7580;padding:8px 6px 4px}}
.promises{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:.28in}}
.promises div{{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:14px;padding:11px 13px;font-size:12px;line-height:1.45}}
.promises b{{display:block;font-size:13.5px;color:#fff;margin-bottom:2px}}
.cover .cfoot{{position:absolute;left:.65in;right:.65in;bottom:.35in;font-size:11px;opacity:.7;display:flex;justify-content:space-between}}
/* everything included page */
.inc h2{{font-size:32px;margin:0 0 6px}}
.inc .lead{{font-size:14px;color:#4a5560;margin:0 0 18px;max-width:6.6in;line-height:1.55}}
.feat{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.feat div{{background:#fff;border:1px solid #e7e5df;border-radius:14px;padding:13px 15px}}
.feat b{{display:block;font-size:13.5px;margin-bottom:3px}}
.feat span{{font-size:12px;color:#4a5560;line-height:1.45}}
.ov{{margin-top:18px;background:#101a24;color:#fff;border-radius:18px;padding:18px 22px;display:grid;grid-template-columns:1.1fr 1fr;gap:22px;align-items:center}}
.ov h3{{margin:0 0 6px;font-size:18px;font-family:"Inter Display"}}
.ov p{{margin:0;font-size:12.5px;line-height:1.55;opacity:.85}}
.ov table{{width:100%;border-collapse:collapse;font-size:12px}}
.ov td{{padding:6px 0;border-top:1px solid rgba(255,255,255,.12)}} .ov td:last-child{{text-align:right;font-weight:700}}
.ov tr:first-child td{{border-top:none}}
/* industry pages */
.ind{{border-top:10px solid var(--c)}}
.ihead{{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}}
.kick{{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--c)}}
.ind h2{{font-size:36px;margin:2px 0 4px;color:#18212b}}
.who{{font-size:12.5px;color:#6b7580}}
.big{{flex:none;width:2.25in;background:linear-gradient(150deg,var(--deep),var(--c));color:#fff;border-radius:16px;padding:14px 16px}}
.big b{{display:block;font-size:24px;line-height:1.05}} .big span{{display:block;font-size:15px;font-weight:700;color:var(--hi);margin-top:2px}} .big small{{display:block;font-size:11px;opacity:.8;margin-top:6px;line-height:1.4}}
.ind .lead{{font-size:13.5px;line-height:1.55;color:#3c4752;margin:14px 0 14px;max-width:6.8in}}
.cmp{{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;background:#fff;border:1px solid #e7e5df;border-radius:16px;overflow:hidden}}
.cmp th,.cmp td{{padding:9px 12px;border-top:1px solid #f0eee9;vertical-align:middle;text-align:left}}
.cmp thead tr:first-child th{{border-top:none;vertical-align:bottom;padding-top:14px}}
.cmp tbody th{{font-weight:500;color:#2a3440;width:34%}}
.cmp .them{{color:#6b7580;width:22%}}
.cmp .us{{width:22%;background:color-mix(in srgb,var(--c) 5%,#fff)}}
.cmp .us.pro{{background:color-mix(in srgb,var(--c) 11%,#fff)}}
.cmp .lbl{{display:block;font-size:13px;font-weight:700;color:#18212b}}
.cmp .them .lbl{{color:#4a5560}}
.cmp .eg{{display:block;font-size:10.5px;color:#8a929b;font-weight:500;margin-top:1px}}
.cmp .tagp{{display:inline-block;background:var(--c);color:#fff;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;margin-bottom:5px}}
.cmp tr.price th,.cmp tr.price td{{font-size:12.5px;padding-top:11px;padding-bottom:11px;border-top:2px solid #e7e5df}}
.cmp tr.price th{{font-weight:700}}
.cmp tr.price .us b{{font-family:"Inter Display";font-size:24px;color:var(--c);letter-spacing:-.02em}}
.cmp tr.price .us small{{font-size:11px;color:#6b7580;margin-left:2px}}
.cmp tr.price .them{{font-weight:700;color:#4a5560;font-size:13px}}
.ck{{display:inline-flex;width:20px;height:20px;border-radius:50%;background:var(--c);color:#fff;align-items:center;justify-content:center;font-size:11px;font-weight:800}}
.ck.dim{{background:#d9dde1;color:#fff}}
.no{{color:#b7bec5;font-weight:700}}
.cmp td.us b{{font-weight:600;color:#18212b}}
.win{{margin-top:14px;border-left:5px solid var(--c);background:#fff;border-radius:12px;padding:12px 16px;font-size:12.8px;line-height:1.55;color:#2a3440;box-shadow:0 8px 24px -16px rgba(0,0,0,.25)}}
.wk{{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:800;color:var(--c);margin-bottom:3px}}
/* back */
.back{{background:#101a24;color:#fff}}
.back .bg{{position:absolute;inset:0;background:radial-gradient(60% 50% at 85% 15%,rgba(47,111,79,.5),transparent 60%),radial-gradient(55% 45% at 10% 90%,rgba(36,83,138,.5),transparent 60%)}}
.back .in{{position:relative}}
.back h2{{font-size:40px;line-height:1.05;margin:.4in 0 12px}}
.back h2 em{{font-style:normal;color:#7fd3a6}}
.steps{{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:22px}}
.steps div{{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:16px}}
.steps .pnum{{font-size:30px;font-weight:800;color:#7fd3a6;line-height:1}}
.steps b{{display:block;font-size:14.5px;margin:8px 0 4px}}
.steps span{{font-size:12px;opacity:.82;line-height:1.5}}
.demo{{margin-top:22px;background:#fff;color:#18212b;border-radius:18px;padding:16px 20px}}
.demo h3{{margin:0 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b7580}}
.demo .g{{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}}
.demo .g div{{border-left:4px solid var(--c);padding-left:10px;font-size:11px;color:#6b7580;line-height:1.35}}
.demo .g b{{display:block;font-family:"Inter Display";font-size:15px;color:#18212b;letter-spacing:-.01em}}
.contact{{margin-top:22px;display:flex;justify-content:space-between;align-items:center;font-size:13px}}
.contact b{{font-size:18px;display:block;font-family:"Inter Display"}}
.qr{{background:#fff;border-radius:12px;padding:7px;width:1.05in;height:1.05in}} .qr img{{width:100%;height:100%}}
</style></head><body>
<section class="page cover"><div class="bg"></div><div class="dots"></div><div class="in">
 <div class="logo"><div class="mk">D</div><div>Donna<small>by Sidekick Logistics</small></div></div>
 <h1>One flat price.<br><em>Every call answered.</em></h1>
 <p class="sub">Donna answers, books, texts and follows up for one monthly price, with no setup fee, no contract and no per-seat fees. In every industry she costs less than the software-plus-answering stack owners pay today, and she does more of the work.</p>
 <div class="glance"><h3>The plans at a glance</h3><table><thead><tr><th>Industry</th><th>Starter · one person</th><th>Pro · unlimited team</th></tr></thead><tbody>{glance}</tbody></table>
  <div class="note">Extra minutes: 25¢ on Starter, 20¢ on Pro. Every feature is in both plans.</div></div>
 <div class="promises">
  <div><b>Never more than the next plan</b>A busy Starter month is capped at the Pro price.</div>
  <div><b>Spam is free</b>Robocalls and spam never count against your minutes.</div>
  <div><b>Texts and emails included</b>No per-message charges, ever.</div>
  <div><b>No surprises</b>Donna tells you at 80% and 100% of your minutes. Calls are never cut off.</div>
  <div><b>Month to month</b>Cancel any time from your dashboard.</div>
  <div><b>14 days free</b>The trial starts the day Donna answers her first real call.</div>
 </div></div>
 <div class="cfoot"><span>Pricing as of November 2026</span><span>sidekicklogistics.com</span></div>
</section>
<section class="page inc">
 <div class="kick" style="color:#2f6f4f">Every plan, every industry</div>
 <h2>What's included</h2>
 <p class="lead">Starter and Pro do the same things. Pro adds your whole team and more minutes, never a locked feature.</p>
 <div class="feat">
  <div><b>Answers every call, 24/7</b><span>In under two rings, day and night, in 25 languages.</span></div>
  <div><b>Books real appointments</b><span>Only open times, on Donna's calendar or your Google or Outlook calendar.</span></div>
  <div><b>Texts and reminders</b><span>Confirmations, reminders, reschedules and cancellations by text.</span></div>
  <div><b>Answers your email inbox</b><span>The same answers by phone, email and text.</span></div>
  <div><b>Your booking page and QR code</b><span>Customers book themselves, in your colors.</span></div>
  <div><b>Call transcripts and summaries</b><span>See what every caller asked and what Donna did.</span></div>
  <div><b>Your industry's playbook</b><span>Salon books, contractor dispatch and invoices, property work orders and HOA dues, real estate showings and listings.</span></div>
  <div><b>Set up in minutes</b><span>Donna reads your website, proposes everything and calls you for a test call. In English, Spanish, Vietnamese, Chinese or Korean.</span></div>
 </div>
 <div class="ov"><div><h3>How extra minutes work</h3><p>Minutes are time Donna spends on calls. Go over and extra minutes are 25¢ on Starter or 20¢ on Pro, about half of what most competitors charge. And a Starter bill never goes above the Pro price.</p></div>
  <table><tr><td>Everyday Starter, 200 min used</td><td>$49</td></tr><tr><td>Everyday Starter, 400 min used</td><td>$74</td></tr><tr><td>Everyday Starter, 900 min used</td><td>$149 (capped)</td></tr><tr><td>Everyday Pro, 1,200 min used</td><td>$189</td></tr></table></div>
 <div class="foot"><span>Donna by Sidekick Logistics</span><span>2</span></div>
</section>
{pages}
<section class="page back"><div class="bg"></div><div class="in">
 <div class="logo"><div class="mk">D</div><div>Donna<small>by Sidekick Logistics</small></div></div>
 <h2>Hear her yourself.<br><em>Then try her free for 14 days.</em></h2>
 <div class="steps">
  <div><div class="pnum">1</div><b>Call a demo line</b><span>Talk to Donna the way your customers would. Ask about prices, book something, try another language.</span></div>
  <div><div class="pnum">2</div><b>Set her up in minutes</b><span>She reads your website and proposes your services, hours and answers. You confirm.</span></div>
  <div><div class="pnum">3</div><b>Forward your line</b><span>Keep your number. The 14-day trial starts the day she answers her first real call.</span></div>
 </div>
 <div class="demo"><h3>Demo lines</h3><div class="g">
  <div style="--c:#2f6f4f"><b>(817) 618-8666</b>Everyday business</div>
  <div style="--c:#8a3a5c"><b>(817) 506-4765</b>Salon</div>
  <div style="--c:#c2561a"><b>(817) 618-8666</b>Contractor</div>
  <div style="--c:#24538a"><b>(817) 318-6267</b>Property management</div>
  <div style="--c:#0f6e6a"><b>(817) 632-7038</b>Real estate</div>
 </div></div>
 <div class="contact"><div><b>Ready to start?</b>accounts@sidekicklogistics.com · sidekicklogistics.com</div><div class="qr"><img src="../img/qr-site.svg"></div></div>
</div>
 <div class="cfoot" style="position:absolute;left:.65in;right:.65in;bottom:.35in;font-size:9.5px;opacity:.6">Prices in US dollars, per month, before applicable taxes. Competitor figures are typical public list prices, rounded, as of November 2026, and can change.</div>
</section>
</body></html>'''
open('/home/claude/donna-dashboard/sales/pricing/donna-pricing.html','w').write(out)
print('ok')
