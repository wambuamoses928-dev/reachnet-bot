import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars");
}

export const db: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type BotLink = {
  id: string;
  user_id: string;
  platform: "whatsapp" | "telegram";
  status: "pending" | "connected" | "disconnected";
  phone_e164?: string | null;
  pairing_code?: string | null;
  pairing_code_at?: string | null;
  telegram_chat_id?: string | null;
};

export type LinkedGroup = {
  id: string;
  link_id: string;
  platform: "whatsapp" | "telegram";
  group_ref: string; // WhatsApp: @g.us id | Telegram: chat id
  name: string;
  member_count: number;
  description?: string | null;
  links: string[];
  owner_is_user: boolean;
  enabled: boolean; // user toggles off official / restricted groups
  attributes: Record<string, unknown>;
};

export type Broadcast = {
  id: string;
  user_id: string;
  content: string;
  reachnet_material_id?: string | null;
  reachnet_ad_id?: string | null;
  /** delivery form: plain group message or WhatsApp group status (green ring) */
  mode?: "chat" | "status" | null;
  media_url?: string | null;
  media_kind?: string | null;
  media_mimetype?: string | null;
  link_id?: string | null;
  status: "queued" | "sending" | "done" | "partial" | "failed";
  stats?: Record<string, unknown> | null;
};

/** All active WhatsApp sessions to restore on boot. */
export async function activeWhatsappLinks(): Promise<BotLink[]> {
  const { data, error } = await db
    .from("bot_links")
    .select("*")
    .eq("platform", "whatsapp")
    .eq("status", "connected");
  if (error) throw error;
  return (data ?? []) as BotLink[];
}

export async function updateLink(
  id: string,
  patch: Partial<BotLink>
): Promise<void> {
  const { error } = await db.from("bot_links").update(patch).eq("id", id);
  if (error) throw error;
}

/** Upsert the groups a session can see; preserve user's enabled toggles. */
export async function syncGroups(
  linkId: string,
  platform: "whatsapp" | "telegram",
  groups: Array<Omit<LinkedGroup, "id" | "link_id" | "enabled" | "platform">>
): Promise<number> {
  const { data: existing } = await db
    .from("linked_groups")
    .select("id, group_ref, enabled")
    .eq("link_id", linkId);
  const enabledByRef = new Map(
    (existing ?? []).map((g: { group_ref: string; enabled: boolean }) => [
      g.group_ref,
      g.enabled,
    ])
  );

  const rows = groups.map((g) => ({
    link_id: linkId,
    platform,
    group_ref: g.group_ref,
    name: g.name,
    member_count: g.member_count,
    description: g.description ?? null,
    links: g.links,
    owner_is_user: g.owner_is_user,
    attributes: g.attributes,
    enabled: enabledByRef.has(g.group_ref)
      ? (enabledByRef.get(g.group_ref) as boolean)
      : true,
    last_seen_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return 0;

  const { error } = await db.from("linked_groups").upsert(rows, {
    onConflict: "link_id,group_ref",
  });
  if (error) throw error;
  return rows.length;
}

export async function fetchQueuedBroadcasts(): Promise<Broadcast[]> {
  const { data, error } = await db
    .from("broadcasts")
    .select("*")
    .eq("status", "queued")
    .order("created_date", { ascending: true })
    .limit(5);
  if (error) throw error;
  return (data ?? []) as Broadcast[];
}

export async function enabledGroupsForUser(userId: string): Promise<
  Array<LinkedGroup & { link: BotLink }>
> {
  const { data, error } = await db
    .from("linked_groups")
    .select("*, link:bot_links!inner(*)")
    .eq("enabled", true)
    .eq("bot_links.user_id", userId);
  if (error) throw error;
  return (data ?? []) as Array<LinkedGroup & { link: BotLink }>;
}

export async function updateBroadcast(
  id: string,
  patch: Partial<Broadcast>
): Promise<void> {
  const { error } = await db.from("broadcasts").update(patch).eq("id", id);
  if (error) throw error;
}
