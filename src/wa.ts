import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { db, syncGroups, updateLink, type BotLink } from "./store.js";

const log = pino({ name: "wa" });

// One live Baileys socket per connected user session.
export const sessions = new Map<string, WASocket>(); // linkId -> sock
const dataDir = process.env.SESSION_DIR ?? "./data/sessions";

function attrsFromMeta(meta: GroupMetadata, isOwner: boolean) {
  return {
    memberCount: meta.size ?? meta.participants?.length ?? 0,
    isAnnouncement: meta.announce ?? false, // "admin only" groups — user can't send
    isCommunity: meta.isCommunity ?? false,
    ownerJid: meta.owner ?? null,
    restrictedJoin: meta.restrict ?? false,
    isOwner,
  };
}

function extractLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:chat\.)?whatsapp\.com\/[^\s<>"']+/gi;
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

/** Full group sync: every group the linked WhatsApp account is IN (not just admin). */
export async function syncAllGroups(linkId: string, sock: WASocket) {
  const list = await sock.groupFetchAllParticipating();
  const groups = Object.values(list).map((meta) => {
    const me = sock.user?.id?.replace(/:\d+$/, "");
    const isOwner = meta.owner === me || me === undefined ? (meta.owner ?? "") === me : false;
    return {
      group_ref: meta.id,
      name: meta.subject,
      member_count: meta.size ?? meta.participants?.length ?? 0,
      description: meta.desc ?? null,
      links: extractLinks(meta.desc),
      owner_is_user: isOwner,
      attributes: attrsFromMeta(meta, isOwner),
    };
  });
  const n = await syncGroups(linkId, "whatsapp", groups);
  log.info({ linkId, groups: groups.length }, "whatsapp groups synced");
  return n;
}

type OnConnected = (linkId: string, sock: WASocket) => void | Promise<void>;

async function startSession(
  link: BotLink,
  onConnected: OnConnected
): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(
    `${dataDir}/${link.id}`
  );
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["ReachNet", "Chrome", "124.0.0"],
    markOnlineOnConnect: false, // stay "offline": messages still deliver, looks human
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (upd) => {
    const { connection, lastDisconnect, qr } = upd;
    if (qr) {
      // QR fallback — primary path is the pairing code (see linkWhatsapp()).
      const qrcode = await import("qrcode-terminal");
      qrcode.default.generate(qr, { small: true });
      log.info({ linkId: link.id }, "QR available (fallback)");
    }
    if (connection === "open") {
      sessions.set(link.id, sock);
      await updateLink(link.id, { status: "connected", pairing_code: null });
      await syncAllGroups(link.id, sock);
      await onConnected(link.id, sock);
      log.info({ linkId: link.id }, "whatsapp session connected");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } })
        ?.output?.statusCode;
      const shouldReconnect =
        code !== DisconnectReason.loggedOut && code !== 401;
      sessions.delete(link.id);
      if (shouldReconnect) {
        log.warn({ linkId: link.id, code }, "reconnecting whatsapp session…");
        await updateLink(link.id, { status: "pending" });
        setTimeout(() => void startSession(link, onConnected), 5_000);
      } else {
        log.error({ linkId: link.id }, "session logged out — marking disconnected");
        await updateLink(link.id, { status: "disconnected" });
      }
    }
  });

  return sock;
}

/** Step 1 of linking: create the link row, fire up a session, return the pairing
 *  code the user types into WhatsApp → Linked devices. No QR scan needed. */
export async function linkWhatsapp(
  userId: string,
  phoneE164: string
): Promise<{ linkId: string; pairingCode: string }> {
  const { data: link, error } = await db
    .from("bot_links")
    .insert({
      user_id: userId,
      platform: "whatsapp",
      status: "pending",
      phone_e164: phoneE164,
    })
    .select()
    .single();
  if (error) throw error;

  const sock = await startSession(link as BotLink, async () => {});

  const pairingCode = await sock.requestPairingCode(phoneE164);
  await updateLink(link.id, { pairing_code: pairingCode as string });
  log.info({ linkId: link.id }, "pairing code issued");
  return { linkId: link.id, pairingCode: pairingCode as string };
}

/** Boot-time: bring back every previously connected session. */
export async function restoreSessions(onConnected: OnConnected) {
  const { data: links } = await db
    .from("bot_links")
    .select("*")
    .eq("platform", "whatsapp")
    .eq("status", "connected");
  for (const link of (links ?? []) as BotLink[]) {
    try {
      await startSession(link, onConnected);
    } catch (e) {
      log.error({ linkId: link.id, err: String(e) }, "failed to restore session");
      await updateLink(link.id, { status: "disconnected" });
    }
  }
}

export async function sendToGroup(
  sock: WASocket,
  groupRef: string,
  content: string
): Promise<boolean> {
  try {
    await sock.sendMessage(groupRef, { text: content });
    return true;
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "send failed");
    return false;
  }
}
