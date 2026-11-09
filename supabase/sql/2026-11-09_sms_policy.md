# SMS policy (Nov 9, 2026) — applies to every Donna (General, Salon, PM, Contractor, Real estate)

**Notifications** — confirmations, reminders, pay/estimate/sign links, one-time codes, crew pages, owner alerts, broadcasts,
win-back, reviews — ALWAYS go out from the shared toll-free number via its Twilio Messaging Service
(`app_config.twilio_messaging_service_sid`). Never from a tenant's own number. Until the toll-free verification is
approved, Twilio accepts these and carriers drop them; `msg-send` returns `tollfree_verified:false` + a warning so logs
show it. `admin-sms` refreshes `app_config.tollfree_verified` each time the Admin → SMS panel loads.

**Two-way texting** — Donna replying in a conversation on the tenant's own number — only when
`accounts.settings.sms.two_way === true` AND `settings.sms.two_way_verified === true` (platform admin sets both in
Admin → account → Texting, after Twilio approves the number's A2P registration) AND the account has `assistants.sms_number`.
Otherwise `msg-send` refuses `two_way` sends (`two_way_not_ready`) and `msg-inbound` acknowledges the text inline,
emails the owner, and marks the conversation `awaiting_staff`. Appointment keywords (C / R / CANCEL / late / when) still
answer inline on either number because the TwiML reply rides the inbound webhook, not an outbound send.

Enforced in: `msg-send` v5 (the single choke point every function uses), `msg-inbound` v13, `msg-quick` v5 (passes
`two_way` through), `msg-brain` (passes `from` = tenant number → treated as two-way). `admin-api` v15 `set_sms_two_way`
(admin-api source is not kept in this repo). `admin-sms` v4.
