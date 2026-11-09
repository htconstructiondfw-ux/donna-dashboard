-- Applied 2026-11-09. Transcript lines are written by Retell's call_ended AND call_analyzed webhooks (~100ms apart);
-- uniqueness per (call, speaker, said_at) lets concurrent writers converge instead of doubling every line.
delete from public.transcript_messages a using public.transcript_messages b
where a.call_id = b.call_id and a.speaker = b.speaker and a.said_at = b.said_at and a.text = b.text and a.id > b.id;
create unique index if not exists transcript_messages_call_speaker_said_uniq
  on public.transcript_messages (call_id, speaker, said_at);
