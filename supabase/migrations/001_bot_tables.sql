-- ReachNet broadcast bot: linking + groups + broadcasts
-- Run against the ReachNet Supabase project (service role).

create extension if not exists "pgcrypto";

-- One row per user<->platform connection (WhatsApp session or Telegram link).
create table if not exists public.bot_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.reachnet_profiles(id) on delete cascade,
  platform text not null check (platform in ('whatsapp', 'telegram')),
  status text not null default 'pending' check (status in ('pending', 'connected', 'disconnected')),
  phone_e164 text,
  pairing_code text,
  telegram_chat_id text,
  connected_at timestamptz,
  created_date timestamptz not null default now(),
  updated_date timestamptz not null default now(),
  unique (user_id, platform)
);

-- Every group the linked account is a member of. `enabled` is the user's
-- on/off toggle in ReachNet (they disable official / restricted groups;
-- disabled groups are skipped by the broadcast worker).
create table if not exists public.linked_groups (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.bot_links(id) on delete cascade,
  platform text not null check (platform in ('whatsapp', 'telegram')),
  group_ref text not null,           -- WhatsApp: 123...@g.us | Telegram: -100...
  name text not null,
  member_count int not null default 0,
  description text,
  links jsonb not null default '[]',
  owner_is_user boolean not null default false,
  enabled boolean not null default true,
  attributes jsonb not null default '{}',
  last_seen_at timestamptz not null default now(),
  created_date timestamptz not null default now(),
  updated_date timestamptz not null default now(),
  unique (link_id, group_ref)
);

-- Broadcast jobs. The ReachNet UI inserts a 'queued' row; the Railway worker
-- claims, sends to all enabled groups, and writes back stats.
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.reachnet_profiles(id) on delete cascade,
  content text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'done', 'partial', 'failed')),
  stats jsonb,
  sent_at timestamptz,
  created_date timestamptz not null default now(),
  updated_date timestamptz not null default now()
);

create index if not exists broadcasts_status_idx on public.broadcasts (status, created_date);
create index if not exists linked_groups_user_idx on public.linked_groups (link_id, enabled);

-- RLS: users see their own links/groups/broadcasts; the worker uses the
-- service role (bypasses RLS).
alter table public.bot_links enable row level security;
alter table public.linked_groups enable row level security;
alter table public.broadcasts enable row level security;

drop policy if exists "own bot_links" on public.bot_links;
create policy "own bot_links" on public.bot_links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own linked_groups" on public.linked_groups;
create policy "own linked_groups" on public.linked_groups
  for select using (
    exists (
      select 1 from public.bot_links l
      where l.id = link_id and l.user_id = auth.uid()
    )
  );

drop policy if exists "own broadcasts" on public.broadcasts;
create policy "own broadcasts" on public.broadcasts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
