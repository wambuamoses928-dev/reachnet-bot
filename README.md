# reachnet-bot

ReachNet's broadcast worker. Runs on Railway as a persistent Node service.

## What it does
- **WhatsApp (Baileys, multi-session):** each user links their own WhatsApp via a
  pairing code (no QR scan). The worker restores all sessions on boot, re-syncs on
  reconnect. Groups = **every group the account is in**, not just admin groups.
- **Telegram (grammY):** user links with `/link <code>` in DM, then adds the bot as
  admin to the groups they want to broadcast to.
- **Group sync:** each group is stored with name, member count, description,
  extracted links, and attributes (announcement-only, owner, restricted…).
- **Toggles:** ReachNet's UI flips `linked_groups.enabled` — the user disables
  official / restricted groups; the worker only sends to enabled ones.
- **Broadcasts:** ReachNet inserts a `queued` row in `broadcasts`; the worker sends
  to every enabled group with randomized 25–70s human-like gaps, then writes stats.

## Deploy (Railway)
1. Railway → New Project → Deploy from GitHub repo `reachnet-bot` (this repo).
2. Add a **Volume** mounted at `/data/sessions` (WhatsApp session persistence).
3. Set env vars from `.env.example` (Supabase service key from ReachNet's project).
4. Healthcheck: GET `/health`.

## Database
Apply `supabase/migrations/001_bot_tables.sql` to ReachNet's Supabase project.

## Anti-ban posture
- `markOnlineOnConnect: false` — the linked account stays "offline" in WhatsApp.
- 25–70s randomized gaps between group sends; no bursts.
- Per-user sessions (broadcasts come from the user's own number, not a central one).
- Sessions persist across restarts via the mounted volume.
