-- When the current pairing code was issued (codes expire ~2 min; the UI
-- counts down from this so reloads and mid-pairing reconnects stay honest).
alter table public.bot_links
  add column if not exists pairing_code_at timestamptz;
