import re, sys
D='/home/claude/donna-dashboard/sales/'
PHONE_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>'
I={
 'cal':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
 'globe':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
 'team':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9"/></svg>',
 'home':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
}
def phone(thread, name, left, top, init='D', w=None, h=None):
    st=f'left:{left};top:{top};'+(f'width:{w};' if w else '')+(f'height:{h};' if h else '')
    return f'<div class="phone" style="{st}"><div class="scr"><div class="notch"></div><div class="hd"><div class="av">{init}</div><div class="nm">{name}</div></div><div class="th">{thread}</div></div></div>'
def bub(cls,t): return f'<div class="bub {cls}">{t}</div>'
def ts(t): return f'<div class="ts">{t}</div>'

CFG={
'general':dict(file='donna-general',theme='t-general',ind='Detailers · cleaners · trainers · repair shops · consultants',
 tag='For any small business that lives on the phone',
 h1='Never miss <em>another call</em>. Or another customer.',
 sub='Donna is an AI receptionist that answers your line 24/7, knows your services and prices, books real openings on your calendar and texts the customer. Set up in an afternoon.',
 ticks=['Answers in under two rings, day and night, in 25 languages','Books real appointments and texts the confirmation','Reminders, review asks and rebook nudges on autopilot','Every team member can see Donna\'s bookings on their own Google or Outlook calendar'],
 phonenum='(817) 618-8666',call='Call Donna at Sidekick Logistics. Ask about hours, services, or book a demo.',
 thread=ts('Today 9:42 PM')+bub('in','Hi Marcus, you\'re booked for a <b>Full Detail</b> on Sat Nov 14 at 10:00 AM at 2210 Oak Hollow Dr. See you then!')+bub('in','Reply C to confirm, R to reschedule, or CANCEL.')+bub('out','C')+bub('in','Confirmed. Thanks, Marcus! 👍')+ts('Fri 6:00 PM')+bub('in','Reminder: your Full Detail is tomorrow at 10:00 AM.'),
 pname="Joe's Mobile Detailing",init='J',
 f1=('Incoming call · 9:41 PM','<span class="live"></span><b>Donna answered</b><br>New customer, full detail'),
 f2=('Booked','<span class="ok">✓</span><b>Sat 10:00 AM</b><br>Full Detail · $220 · 3 hrs')),
'salon':dict(file='donna-salon',theme='t-salon',ind='Hair salons · barbershops · nail & lash · spas & med-spas',
 tag='For salons, barbershops, spas and studios',
 h1='The front desk that <em>never misses a client</em>.',
 sub='Donna answers the phone while you\'re mid-blowout, books the right stylist in the right gap, confirms by text, fills cancellations from your waitlist and brings regulars back on their own rhythm.',
 ticks=['Knows every service, price, stylist and how long it takes','Text-first: confirm, reschedule or cancel with one reply','Waitlist fills cancellations before you notice the hole','Each stylist logs in and sees their book on their own phone calendar'],
 phonenum='(817) 506-4765',call='Call our demo salon. Ask about prices, or book a haircut.',
 thread=ts('Today 8:51 PM')+bub('out','Hi! Anything for a cut &amp; color with Mai this week?')+bub('in','Hi Priya! Mai has Thursday at 1:00, 2:00 or 3:00 for a cut &amp; color. I\'ve noted your sensitive scalp. Which works?')+bub('out','3 please')+bub('in','You\'re booked with Mai, Thu Nov 12 at 3:00 PM. Reply C to confirm, R to reschedule, or CANCEL.')+bub('out','C 💕'),
 pname='Luxe Studio Salon',init='L',
 f1=('Waitlist','<span class="ok">✓</span><b>2:00 PM filled</b><br>From the waitlist, automatically'),
 f2=('On Mai\'s calendar','<b>Cut &amp; Color · Priya</b><br>Thu 3:00 – 5:45 PM')),
'contractor':dict(file='donna-contractor',theme='t-contractor',ind='HVAC · plumbing · electrical · lawn · pool · roofing · handyman',
 tag='For one-truck and small-crew shops in the trades',
 h1='She books the job. You do the work. <em>Then she gets you paid.</em>',
 sub='Donna answers every call, quotes your trip fee, books the visit with the address, pages the on-call tech after hours, and when you text DONE she sends the bill. Your money goes straight to your bank.',
 ticks=['Gets the address first, offers only times a tech can reach','After-hours paging that escalates until someone takes it','Text OMW, LATE, DONE from the truck. No app to learn.','Each tech\'s jobs land on their own Google or Outlook calendar'],
 phonenum='(817) 618-8666',call='Call Donna at Sidekick Logistics. Ask what we do, or book a time.',
 thread=ts('Thu 7:38 AM')+bub('in','Joe from Joe\'s HVAC is on the way, about 20 minutes.')+ts('Thu 9:12 AM')+bub('in','Thanks for choosing Joe\'s HVAC! Capacitor replacement + service call: <b>$289.00</b><br><span class="paybtn">Pay $289.00</span>')+bub('out','Paid, thanks Joe!')+bub('in','Payment received. Your receipt is on its way. 🙌'),
 pname="Joe's HVAC",init='J',
 f1=('Tech texted Donna','<b>DONE</b> · capacitor, 1 hr<br>Invoice texted right away'),
 f2=('Paid','<span class="ok">✓</span><b>$289.00</b><br>Deposited to your bank')),
'pm':dict(file='donna-pm',theme='t-pm',ind='Residential rentals · commercial & flex · HOAs & condos',
 tag='For property, community and building managers',
 h1='Every call about every property. <em>Answered.</em>',
 sub='Donna knows which property the caller means and whose job the problem is. She logs the work order, alerts the on-call tech, takes the ARC request, releases the gate code, books the showing and now collects HOA dues.',
 ticks=['Emergencies reach someone now, and escalate on their own','Work orders, ARC, violations and resale certs with due dates','HOA dues by bank or card, with autopay and late notices','Every manager\'s showings land on their own calendar'],
 phonenum='(817) 318-6267',call='Call our demo property line. Report a leak or ask about dues.',
 thread=ts('Mon 2:52 AM')+bub('out','Water coming through the ceiling in 7B!!')+bub('in','Shut off the water at the valve under the sink if you can. I\'ve alerted the on-call tech. Ref SR-711C98.')+bub('in','Mike Torres accepted and is on the way. ETA 35 min.')+ts('Dec 1')+bub('in','Sunset Ridge HOA: your December dues of <b>$285.00</b> are due today.<br><span class="paybtn">Pay by bank</span>'),
 pname='Sunset Ridge HOA',init='S',
 f1=('After hours · 2:52 AM','<span class="live"></span><b>Emergency logged</b><br>On-call tech paged by text'),
 f2=('HOA dues','<span class="ok">✓</span><b>$285.00 paid</b><br>By bank · autopay on')),
're':dict(file='donna-real-estate',theme='t-re',ind='Agents · teams · brokers · rentals you manage',
 tag='For agents, teams and brokers',
 h1='Answers every call about your listings. <em>You stay in the car.</em>',
 sub='Donna knows every active listing, answers "is it still available?" with the real answer, books the showing on your calendar, texts the showing agreement for signature and hands you qualified leads.',
 ticks=['Beds, baths, price, pets and status from your own listings','Showings booked with travel time between them','Agreements and applications signed from a text','Each agent\'s showings land on their own Google or Outlook calendar'],
 phonenum='(817) 632-7038',call='Call the demo line. Ask about a 4-bedroom rental or book a showing.',
 thread=ts('Sat 9:05 AM')+bub('in','You\'re booked to see <b>3907 Belle Maison</b> today at 1:00 PM with Dana.')+bub('in','Please sign the showing agreement before we meet: <span class="lk">sign.sidekick…/a8F2</span>')+bub('out','Signed!')+bub('in','Got it, thank you. You\'re confirmed. See you at 1:00! 🏡'),
 pname='Dana Reyes Realty',init='D',
 f1=('Hot lead','<span class="live"></span><b>Seller · Pecan Dr</b><br>Wants a valuation this week'),
 f2=('Signed','<span class="ok">✓</span><b>Showing agreement</b><br>Phone verified · 9:07 AM')),
}

def cover(c):
    KEY=[k for k,v in CFG.items() if v is c][0]
    ticks=''.join(f'<li>{t}</li>' for t in c['ticks'])
    ph=phone(c['thread'],c['pname'],'.55in','.35in',c['init'])
    f1=f'<div class="float" style="left:-.05in;top:.1in;width:2.05in"><div class="k">{c["f1"][0]}</div>{c["f1"][1]}</div>'
    f2=f'<div class="float" style="right:-.12in;top:3.95in;width:2.0in"><div class="k">{c["f2"][0]}</div>{c["f2"][1]}</div>'
    return f'''<section class="page hero">
  <div class="bg"></div><div class="dots"></div>
  <div class="hin">
    <div class="top"><div class="logo"><div class="mk">D</div><div>Donna<small>by Sidekick Logistics</small></div></div><div class="ind">{c['ind']}</div></div>
    <div class="row">
      <div class="lcol">
        <span class="tag">{c['tag']}</span>
        <h1>{c['h1']}</h1>
        <p class="sub">{c['sub']}</p>
        <ul class="ticks">{ticks}</ul>
        <div class="qcard"><div><span class="w">{QUOTE[KEY][0]}</span>{QUOTE[KEY][1]}</div><div><span class="w d">Donna</span>{QUOTE[KEY][2]}</div><div class="src">{"From a real test call" if KEY in ("general","salon","contractor") else "How a call goes"}</div></div>
      </div>
      <div class="rcol">{ph}{f1}{f2}</div>
    </div>
  </div>
  <div class="band"><div class="ring">{PHONE_SVG}</div><div><div class="t">Hear her yourself. {c['call']}</div><div class="num">{c['phonenum']}</div></div><div class="try"><b>Try Donna free</b>accounts@sidekicklogistics.com<br>sidekicklogistics.com</div></div>
  <div class="stats"><div><b>24/7</b>answers every call</div><div><b>2 rings</b>or less</div><div><b>25</b>languages</div><div><b>1 afternoon</b>to set up</div><div><b>$0</b>new hires</div></div>
</section>
'''

def shot(img,url,cap,style='',h=None):
    hs=f' style="height:{h};overflow:hidden"' if h else ''
    return f'<div style="{style}"><div class="shot"><div class="bar"><i></i><i></i><i></i><span>{url}</span></div><div{hs}><img src="img/{img}"></div></div><div class="cap">{cap}</div></div>'

NEWBAND=lambda items: '<div class="newband"><div class="kicker">New this month</div><div class="g">'+''.join(f'<div><div class="ico">{I[i]}</div><h4>{h}</h4><p>{p}</p></div>' for i,h,p in items)+'</div></div>'
CAL_ITEM=('cal','Everyone\'s own calendar','Each person on your team signs in to their own Google or Outlook calendar. Their Donna appointments show up there, moves and cancellations follow, and Donna won\'t book them when they\'re busy.')
LANG_ITEM=('globe','Set up in your language','The setup steps are in English, Spanish, Vietnamese, Chinese and Korean, so owners can get Donna running in the language they read best.')
TEAM_ITEM=('team','A login for everyone','On Pro, add as many people as you need. Each gets their own login, their own schedule and a Today view on their phone.')
DUES_ITEM=('home','HOA dues, collected','Bill a whole community in one step. Owners pay by bank (no fee) or card, set up autopay, and get reminders and late notices without you.')

def showcase(key):
    if key=='general':
        body=f'''<div class="grid2" style="grid-template-columns:1.25fr .75fr;align-items:start;gap:26px;margin-top:14px">
  {shot('salon-time.jpg','donna-dashboard…/book/your-business','<b>Your booking page.</b> Your logo and colors. Customers pick a service and a real open time, verified with a one-time code. (Shown: a salon customer\'s page.)')}
  <div class="showcase">{phone(bub('in','Hi! This is Donna with Joe\'s Mobile Detailing. Sorry we missed you. Want me to text you our booking link?')+bub('out','yes please')+bub('in','Here you go: <span class="lk">book…/joes-detailing</span>. Pick any open time and you\'ll get a confirmation right away.'),"Joe's Mobile Detailing",'0','0','J',None,'3.45in')}<div class="cap" style="margin-top:8px"><b>Missed call? Donna texts back.</b> If someone hangs up, she follows up by text with your link.</div></div>
</div>
<div style="margin-top:12px">{shot('dash-appts.jpg','donna-dashboard-three.vercel.app','<b>Your dashboard.</b> Every booking, call, message and customer in one place, on your phone or computer.',h='1.45in')}</div>'''
        nb=[CAL_ITEM,LANG_ITEM,TEAM_ITEM]
    elif key=='salon':
        body=f'''<div class="grid2" style="gap:20px;margin-top:14px">
  {shot('salon-stylist.jpg','luxestudio · book online','<b>Clients pick their stylist.</b> Each stylist\'s own hours and book, or "first available".',h='2.1in')}
  {shot('salon-time.jpg','luxestudio · book online','<b>Only real openings.</b> Grouped by morning, afternoon and evening, with a waitlist link when the day is full.',h='2.1in')}
</div>
<div class="grid2" style="grid-template-columns:.9fr 1.1fr;gap:20px;margin-top:14px;align-items:start">
  {shot('salon-done.jpg','luxestudio · booked','<b>Booked in under a minute.</b> Confirmed by text, with add-to-calendar.',h='2.5in')}
  <div class="showcase" style="display:flex;gap:14px;align-items:flex-start">{phone(bub('in','Hi An! New booking: Kim A., Women\'s Cut &amp; Style, Tue 1:00 PM. Note: prefers no blow-dry.')+ts('Tue 12:41 PM')+bub('in','Kim texted: running 10 late.')+bub('out','ok thx!'),'Donna → An','0','0','D','2.05in','3.3in')}<div class="cap" style="flex:1;margin-top:6px"><b>Your stylists stay in the loop.</b> New bookings and "running late" texts go straight to the stylist. Every booking also lands on their own phone calendar.</div></div>
</div>'''
        nb=[CAL_ITEM,LANG_ITEM,TEAM_ITEM]
    elif key=='contractor':
        tech=bub('out','OMW 20')+bub('in','Texted Maria: Joe is on the way, about 20 min.')+bub('out','DONE')+bub('in','Nice. What did you do?')+bub('out','replaced capacitor, 1 hr')+bub('in','Capacitor + service call = $289.00. Send the invoice, charge the card on file, or hold?')+bub('out','send')+bub('in','Sent to Maria. I\'ll text you when it\'s paid.')
        cust=ts('Wed 4:10 PM')+bub('out','AC is running but not cooling. Can someone come tomorrow?')+bub('in','Yes! What\'s the address?')+bub('out','118 Sunset Ridge')+bub('in','Thursday I have 8, 9 or 10:30. $49 service call, off the repair.')+bub('out','8')+bub('in','Booked Thu at 8:00 AM. I\'ve texted you a confirmation.')
        body=f'''<p class="lede" style="margin-bottom:6px">No app to learn. The customer texts like normal, and your tech texts Donna from the truck.</p>
<div style="display:flex;gap:.35in;justify-content:center;margin-top:10px">
  <div class="showcase">{phone(cust,'Maria (customer)','0','0','M',None,'4.6in')}<div class="cap" style="width:2.45in;margin-top:8px"><b>The customer.</b> Donna gets the address first and offers only times a tech can reach.</div></div>
  <div class="showcase">{phone(tech,'Donna','0','0','D',None,'4.6in')}<div class="cap" style="width:2.45in;margin-top:8px"><b>Your tech.</b> OMW, LATE, HERE, NEXT, DONE. Donna does the texting and the billing.</div></div>
</div>'''
        nb=[CAL_ITEM,LANG_ITEM,TEAM_ITEM]
    elif key=='pm':
        body=f'''<div style="margin-top:12px">{shot('pm-requests.jpg','donna-dashboard · Service requests','<b>Every request, sorted.</b> Work orders, emergencies, ARC requests, violations and resale certificates, each with a reference number, due date and status.',h='2.35in')}</div>
<div class="grid2" style="grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;align-items:start">
  {shot('pm-time.jpg','book · Test PM Co','<b>Showings and inspections</b> booked by residents and prospects at the unit, address on the confirmation.',h='2.4in')}
  <div class="showcase" style="display:flex;gap:12px;align-items:flex-start">{phone(bub('in','Sunset Ridge HOA: November dues of $285.00 are past due. A $25 late fee applies Nov 15.')+bub('in','Pay by bank (no fee): <span class="lk">pay…/k2Q9</span>')+bub('out','Paid. Can I set up autopay?')+bub('in','Yes. Tap the link and check "Pay automatically."'),'Sunset Ridge HOA','0','0','S','2.0in','3.5in')}<div class="cap" style="flex:1;margin-top:6px"><b>Dues that collect themselves.</b> Statements, reminders, late notices and autopay, paid straight to the association\'s bank.</div></div>
</div>'''
        nb=[DUES_ITEM,CAL_ITEM,LANG_ITEM]
    else: # re
        listing='''<div class="card" style="padding:0;overflow:hidden;box-shadow:0 14px 34px rgba(16,24,40,.14)"><div style="height:1.35in;background:linear-gradient(135deg,var(--accent),var(--deep));position:relative"><div style="position:absolute;left:14px;bottom:10px;color:#fff"><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;opacity:.8">For lease · Active</div><div style="font-family:Inter Display;font-size:20px;font-weight:800">3907 Belle Maison</div></div><div style="position:absolute;right:12px;top:12px;background:#fff;color:var(--accent);font-weight:800;border-radius:999px;padding:4px 12px;font-size:13px">$3,700/mo</div></div>
<div style="padding:12px 14px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11px;color:var(--muted)"><div><b style="display:block;font-size:15px;color:var(--ink)">4 + study</b>bedrooms</div><div><b style="display:block;font-size:15px;color:var(--ink)">3</b>baths</div><div><b style="display:block;font-size:15px;color:var(--ink)">3,010</b>sq ft</div><div><b style="display:block;font-size:15px;color:var(--ink)">Dogs OK</b>pets</div></div>
<div style="padding:0 14px 12px;font-size:11.5px;color:#334">Donna answers from your own listing: <b>"It is still available. Four bedrooms plus a study, three baths, about three thousand square feet, thirty-seven hundred a month, and it allows dogs. Would you like to see it?"</b></div></div>'''
        sign='''<div class="card" style="box-shadow:0 14px 34px rgba(16,24,40,.14);padding:16px"><div class="kicker" style="margin-bottom:4px">Signing certificate</div><div style="font-weight:700;font-size:14px;margin-bottom:8px">Showing agreement · 3907 Belle Maison</div>
<table style="font-size:11px"><tr><td style="color:var(--muted);width:40%">Signed by</td><td>Jordan Lee</td></tr><tr><td style="color:var(--muted)">Phone verified</td><td>One-time code ✓</td></tr><tr><td style="color:var(--muted)">Signed</td><td>Sat Nov 14, 9:07 AM</td></tr><tr><td style="color:var(--muted)">Fingerprint</td><td style="font-family:monospace">9f2c…e41a</td></tr></table>
<div style="margin-top:10px;font-family:'DejaVu Serif',serif;font-style:italic;font-size:22px;color:var(--accent)">Jordan Lee</div></div>'''
        body=f'''<div class="grid2" style="grid-template-columns:1.1fr .9fr;gap:24px;margin-top:14px;align-items:start">
  <div>{listing}<div class="cap"><b>She knows your listings.</b> Import from your MLS export or add by hand. Status changes take effect on the next call.</div>
  <div style="margin-top:18px">{sign}<div class="cap"><b>Signed from a text.</b> You get a PDF with the signature and a signing certificate.</div></div></div>
  <div class="showcase">{phone(bub('in','🔥 Hot lead: Sam Patel wants to SELL 2210 Pecan Dr. Wants a valuation this week. +1 817-555-0144')+bub('in','New showing: Jordan Lee, 3907 Belle Maison, Sat 1:00 PM. Agreement signed ✓')+bub('out','great, on my way after the 12:00')+bub('in','Your 12:00 at Oak Ln ends 12:30, so you have time. It\'s also on your Google Calendar.'),'Donna → Dana','0','0','D','2.35in')}<div class="cap" style="margin-top:8px"><b>You hear about the hot ones right away.</b> Sellers, landlords and pre-approved buyers text you that minute.</div></div>
</div>'''
        nb=[CAL_ITEM,LANG_ITEM,TEAM_ITEM]
    return f'''<section class="page">
  <div class="kicker">See it at work</div>
  <h2>What your customers see, and what you see.</h2>
  {body}
  {NEWBAND(nb)}
  <div class="foot"><span>{TITLE[key]}</span><span>Sidekick Logistics · sidekicklogistics.com</span></div>
</section>
'''
QUOTE={'general': ('Caller', '"How much is a full detail, and do you come to the house?"', '"Two hundred twenty, about three hours, and yes, we come to you. Saturday I have eight, nine or ten. Which works?"'), 'salon': ('Client', '"Can I get a cut and color with Mai Thursday afternoon?"', '"Welcome back, Priya. Mai has one, two or three. I\'ll note your sensitive scalp for her. Which works?"'), 'contractor': ('Caller', '"My AC is running but it\'s not cooling."', '"Let\'s get you on the schedule. What\'s the address? ... Thursday I have eight or nine. There\'s a forty-nine dollar service call that comes off the repair."'), 'pm': ('Resident', '"The disposal at Oakwood 7B is humming and the sink is backing up."', '"Try the reset button under the disposal first. No luck? I\'ve logged it. Reference S R 7 1 1. You\'ll get a text when it\'s scheduled."'), 're': ('Caller', '"Is the house on Belle Maison still available? Does it have four bedrooms?"', '"It is. Four bedrooms plus a study, three baths, thirty-seven hundred a month, and it allows dogs. Saturday I have eleven, one or two thirty."')}
EDITS={
 'salon':[('<li>Syncs to Google or Microsoft calendar.</li>','<li>Syncs to Google or Microsoft calendar, and each stylist can connect their own.</li>')],
 'pm':[('<p>Google or Microsoft calendar sync. Email forwarding','<p>Google or Microsoft calendar sync, for the office and for each manager. Email forwarding')],
 'contractor':[('<li>Owner sees every job, estimate, invoice and text</li>','<li>Owner sees every job, estimate, invoice and text</li>\n      <li>Each tech can connect their own Google or Outlook calendar</li>')],
 're':[('<li>Agents and staff each get their own login</li>','<li>Agents and staff each get their own login</li>\n      <li>Each agent\'s showings land on their own Google or Outlook calendar</li>')],
 'general':[('Add a second person and Donna books with whoever is free. Salons and property managers get Donna with their trade\'s own playbook built in.','Add your team and Donna books with whoever is free. Each person gets their own login and can connect their own Google or Outlook calendar, so their bookings show up where they already look. Salons, contractors, real estate and property managers get Donna with their trade\'s own playbook built in.'),
   ('<li>Syncs to Google or Microsoft calendar if you use one.</li>','<li>Syncs to Google or Microsoft calendar, and each team member can connect their own.</li>')],
}
TITLE={'general':'Donna for your business','salon':'Donna for Salons and Spas','contractor':'Donna for Contractors','pm':'Donna for Property Management','re':'Donna for Real Estate'}

for key,c in CFG.items():
    p=D+c['file']+'.html'; s=open(p).read()
    # restore from git original each run
    import subprocess
    s=subprocess.run(['git','-C','/home/claude/donna-dashboard','show','HEAD:sales/'+c['file']+'.html'],capture_output=True,text=True).stdout
    s=s.replace('<body>',f'<body class="{c["theme"]}">',1)
    s=re.sub(r'<section class="page cover">.*?</section>\n',cover(c),s,count=1,flags=re.S)
    # insert showcase after the first "dense" page
    m=re.search(r'<section class="page dense">.*?</section>\n',s,flags=re.S)
    s=s[:m.end()]+'\n'+showcase(key)+s[m.end():]
    for a,b in EDITS.get(key,[]):
        assert a in s,(key,a[:50]); s=s.replace(a,b)
    open(p,'w').write(s); print('patched',p)
