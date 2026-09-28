import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import * as fs from "node:fs";
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
  let version: [number, number, number] | undefined;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch {
    version = [2, 3000, 1043857760]; // fallback that worked in nexmint-wa-bot
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    browser: ["ReachNet", "Chrome", "124.0.0"],
    markOnlineOnConnect: false, // stay "offline": messages still deliver, looks human
    syncFullHistory: false,
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 30_000,
    defaultQueryTimeoutMs: 120_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (upd) => {
    const { connection, lastDisconnect, qr } = upd;
    if (qr) {
      // QR fallback — primary path is the pairing code (see startPairing()).
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

/**
 * Phone normalization — proven in the nexmint-wa-bot: digits only, with
 * Kenyan local-format fixes. Baileys builds the WA jid straight from this
 * string, so a leading "+" or local 0-format breaks pairing.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  let digits = input.trim().replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = "254" + digits.slice(1);
  } else if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    digits = "254" + digits;
  } else if (digits.startsWith("2540") && digits.length >= 13) {
    digits = "254" + digits.slice(4);
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * API path for pairing — mirrors the pattern that worked in nexmint-wa-bot:
 * fresh auth dir, then request the pairing code inside the `connecting`
 * update after a 3s noise-handshake wait (calling it immediately after
 * socket creation fails; the IQ needs a live websocket).
 */
export async function startPairing(
  userId: string,
  phoneE164: string
): Promise<{ linkId: string; pairingCode: string }> {
  const { data: existing } = await db
    .from("bot_links")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  let link = (existing as BotLink | null) ?? null;

  if (link?.status === "connected") throw new Error("ALREADY_LINKED");

  if (!link) {
    const { data: created, error } = await db
      .from("bot_links")
      .insert({ user_id: userId, platform: "whatsapp", status: "pending", phone_e164: phoneE164 })
      .select()
      .single();
    if (error) throw error;
    link = created as BotLink;
  } else {
    await db
      .from("bot_links")
      .update({ status: "pending", phone_e164: phoneE164, pairing_code: null, updated_date: new Date().toISOString() })
      .eq("id", link.id);
    link = { ...link, status: "pending", phone_e164: phoneE164 };
  }

  const digits = normalizePhone(phoneE164);
  if (!digits) throw new Error("BAD_PHONE");

  // Re-pairing a previously-linked row (or a phone change): clear ALL auth
  // state for this link so the session pairs the NEW number, not the old one.
  const stale = sessions.get(link.id);
  sessions.delete(link.id);
  try {
    stale?.end(new Error("re-pairing"));
  } catch {
    // ignore
  }
  if (link.status === "disconnected" || (existing as BotLink | null)?.phone_e164 !== phoneE164) {
    fs.rmSync(`${dataDir}/${link.id}`, { recursive: true, force: true });
  }

  const sock = await startSession(link, async () => {});

  let pairingCode: string | null = null;
  let pairingErr: string | null = null;
  let requested = false;

  await new Promise<void>((resolve) => {
    const giveUp = setTimeout(() => {
      if (!pairingCode) pairingErr = pairingErr ?? "PAIR_TIMEOUT";
      resolve();
    }, 45_000);

    sock.ev.on("connection.update", async (u: { connection?: string }) => {
      if (u.connection === "connecting" && !requested) {
        requested = true;
        await sleep(3000); // noise handshake
        try {
          pairingCode = await sock.requestPairingCode(digits);
          clearTimeout(giveUp);
          resolve();
        } catch (e) {
          pairingErr = String(e);
          clearTimeout(giveUp);
          resolve();
        }
      }
    });
  });

  if (!pairingCode) throw new Error(pairingErr ?? "PAIR_FAILED");

  await updateLink(link.id, { pairing_code: pairingCode });
  log.info({ linkId: link.id }, "pairing code issued (API)");
  return { linkId: link.id, pairingCode: pairingCode };
}
