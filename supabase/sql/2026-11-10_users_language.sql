-- Applied 2026-11-10 as migration users_language
alter table public.users add column if not exists language text not null default 'en';
comment on column public.users.language is 'The language this person prefers from Donna (setup call, texts). ISO code: en, es, vi, zh, ko.';
