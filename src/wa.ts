import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  DisconnectReason,
  generateWAMessageContent,
  generateWAMessageFromContent,
  generateMessageIDV2,
  jidNormalizedUser,
  type WASocket,
  type GroupMetadata,
} from "@whiskeysockets/baileys";
import * as fs from "node:fs";
import pino from "pino";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { db, syncGroups, updateLink, type BotLink } from "./store.js";

const log = pino({ name: "wa" });

// One live Baileys socket per connected user session.
export const sessions = new Map<string, WASocket>();
// Pairing state (nexmint-wa-bot pattern): the number awaiting a code per link,
// and pending resolvers so the API call can await the code from the handler.
const pairingPhones = new Map<string, string>();

/* ── SENT-MESSAGE STORE ──────────────────────────────────────────
 * Backs the socket's getMessage callback. When a recipient phone
 * can't decrypt a rich message (interactive/viewOnce cards are the
 * classic case) it re-requests the content from the sender's devices;
 * without a store to answer from, the phone shows "Waiting for this
 * message. This may take a while." forever. */
const sentMessages = new Map<string, unknown>();
/* pending relay receipts: id → destination. Cleared when WhatsApp's server
 * acks the message. A relay that stays pending was silently dropped. */
const pendingReceipts = new Map<string, string>();
export function traceReceipt(id: string | undefined, dest: string) {
  if (!id) return;
  pendingReceipts.set(id, dest);
  setTimeout(() => {
    if (pendingReceipts.has(id)) {
      log.warn({ id, dest }, "NO SERVER ACK in 45s — message likely dropped by server");
    }
  }, 45_000).unref?.();
}
export function rememberSent(remoteJid: string, id: string | undefined, content: unknown) {
  if (!id) return;
  sentMessages.set(`${remoteJid}|${id}`, content);
  sentMessages.set(id, content);
  if (sentMessages.size > 4000) {
    for (const k of sentMessages.keys()) {
      sentMessages.delete(k);
      if (sentMessages.size <= 3000) break;
    }
  }
}
// restart-cycle counter per link DURING pairing (nexmint discipline: max 3)
const pairingRetriesByLink = new Map<string, number>();
const pairingWaiters = new Map<string, (code: string | null) => void>(); // linkId -> sock
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
  // ── WA version: EXACT nexmint-wa-bot order — try the LIVE WhatsApp Web
  //    version first (fetchLatestWaWebVersion), then the Baileys-published
  //    one, then the proven constant. An outdated version string is one of
  //    the things WhatsApp rejects device-linking for ("couldn't link device").
  let version: [number, number, number] | undefined;
  try {
    const waResult = (await fetchLatestWaWebVersion({})) as { version?: [number, number, number] };
    if (waResult?.version) {
      version = waResult.version;
      log.info({ version }, "using live WA Web version");
    } else {
      throw new Error("no version in response");
    }
  } catch {
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
      log.warn({ version }, "WA Web fetch failed — using Baileys version");
    } catch {
      version = [2, 3000, 1043857760]; // constant proven in nexmint-wa-bot
    }
  }

  // ── PROXY support (nexmint-wa-bot pattern): WhatsApp blocks pairing from
  //    many datacenter IPs. Set PROXY_URL (http/https/socks) to route the
  //    socket through a residential/mobile proxy.
  const proxyUrl = process.env.PROXY_URL?.trim() || "";
  let proxyAgent: HttpsProxyAgent<string> | SocksProxyAgent | undefined;
  if (proxyUrl) {
    try {
      proxyAgent = proxyUrl.startsWith("socks")
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);
      log.info({ proxy: proxyUrl.replace(/:[^:@/]+@/, ":***@") }, "using proxy for WA socket");
    } catch (e) {
      log.error({ err: String(e) }, "invalid PROXY_URL — connecting without proxy");
    }
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "warn" }),
    // REAL fingerprint, exactly like the working nexmint-wa-bot. A made-up
    // platform string ("ReachNet") is a known cause of instant
    // "couldn't link device — check phone number" rejections.
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false, // stay "offline": messages still deliver, looks human
    syncFullHistory: false,
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 30_000,
    defaultQueryTimeoutMs: 120_000,
    // Answer recipient re-requests for messages we sent (fixes
    // "Waiting for this message" for interactive cards)
    getMessage: async (key) =>
      (sentMessages.get(`${key.remoteJid ?? ""}|${key.id ?? ""}`) ??
        sentMessages.get(key.id ?? "") ??
        undefined) as never,
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  });

  sock.ev.on("creds.update", saveCreds);
  // Server ack/delivery receipts for our own relayed messages.
  // DM acks → messages.update; GROUP acks → message-receipt.update (per participant).
  sock.ev.on("message-receipt.update", (updates) => {
    for (const u of updates) {
      const id = u.key?.id;
      if (id && pendingReceipts.has(id)) {
        log.info(
          { id, dest: pendingReceipts.get(id), receipt: Object.keys(u.receipt ?? {}) },
          "GROUP RECEIPT for relayed message"
        );
        pendingReceipts.delete(id);
      }
    }
  });
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const id = u.key?.id;
      if (id && pendingReceipts.has(id)) {
        log.info(
          { id, dest: pendingReceipts.get(id), status: u.update?.status ?? "ack" },
          "SERVER RECEIPT for relayed message"
        );
        if (u.update?.status !== undefined) pendingReceipts.delete(id);
      }
    }
  });

  let pairingRequestedOnThisSocket = false;

  sock.ev.on("connection.update", async (upd) => {
    const { connection, lastDisconnect, qr } = upd;
    if (qr) {
      // QR fallback — primary path is the pairing code (see startPairing()).
      const qrcode = await import("qrcode-terminal");
      qrcode.default.generate(qr, { small: true });
      log.info({ linkId: link.id }, "QR available (fallback)");
    }

    // ── REQUEST PAIRING CODE — on `connecting` (nexmint-wa-bot pattern) ──
    // Waits for the noise handshake, then asks for the code. Lives HERE so a
    // mid-pairing "Connection Closed" + auto-reconnect re-issues a FRESH code
    // on the new socket (the old one dies with the dead socket).
    if (
      connection === "connecting" &&
      !state.creds.registered &&
      !pairingRequestedOnThisSocket &&
      pairingPhones.get(link.id)
    ) {
      pairingRequestedOnThisSocket = true;
      const digits = pairingPhones.get(link.id)!;
      await sleep(3000); // noise handshake
      try {
        const code = await sock.requestPairingCode(digits);
        await updateLink(link.id, {
          pairing_code: code,
          pairing_code_at: new Date().toISOString(),
        });
        log.info({ linkId: link.id }, "pairing code issued");
        const waiter = pairingWaiters.get(link.id);
        if (waiter) {
          pairingWaiters.delete(link.id);
          waiter(code);
        }
      } catch (e) {
        pairingRequestedOnThisSocket = false; // allow retry on next connect
        const msg = `requestPairingCode: ${String(e)}`;
        log.error({ linkId: link.id, err: msg }, "pairing failed");
        try {
          await db.from("bot_debug").insert({ scope: "pairing", message: msg.slice(0, 500), detail: { linkId: link.id } });
        } catch {
          // best-effort
        }
      }
    }

    if (connection === "open") {
      pairingPhones.delete(link.id);
      pairingRetriesByLink.delete(link.id);
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

      // nexmint-wa-bot pattern: 401/428 while pairing (creds not yet
      // registered) = WhatsApp rejecting the datacenter IP itself. Reconnect
      // loops won't help — record it so the owner can set PROXY_URL.
      const isPairing = pairingPhones.has(link.id);
      if (isPairing && (code === 401 || code === 428)) {
        const msg = `WhatsApp rejected pairing (status ${code}) — likely datacenter IP block. Set PROXY_URL to a residential/mobile proxy.`;
        log.error({ linkId: link.id, code }, msg);
        try {
          await db.from("bot_debug").insert({ scope: "ipblock", message: msg, detail: { linkId: link.id, code } });
        } catch { /* best-effort */ }
        // Do NOT auto-retry in a loop — hammering a blocked IP only makes
        // the block worse. Park the link; the user retries via the UI button.
        await updateLink(link.id, { status: "pending" });
        return;
      }
      if (isPairing) {
        try {
          await db.from("bot_debug").insert({
            scope: "session",
            message: `mid-pairing close, status ${code ?? "?"} — ${String(lastDisconnect?.error ?? "")}`,
            detail: { linkId: link.id },
          });
        } catch { /* best-effort */ }
      }

      const pairingRetries = (pairingRetriesByLink.get(link.id) ?? 0);
      if (shouldReconnect) {
        if (isPairing && pairingRetries >= 3) {
          // nexmint-wa-bot proven discipline: max 3 restart cycles during
          // pairing, then PARK. Endless re-issue loops hammer WhatsApp and
          // trigger 24h+ pairing restrictions (Baileys issue #2691).
          const msg = "Pairing stopped after 3 reconnects — WhatsApp is rate-limiting this attempt. Wait a few minutes, then press 'Get a new code' once.";
          log.warn({ linkId: link.id }, msg);
          try {
            await db.from("bot_debug").insert({ scope: "pairing", message: msg, detail: { linkId: link.id } });
          } catch { /* best-effort */ }
          pairingPhones.delete(link.id);
          return;
        }
        if (isPairing) pairingRetriesByLink.set(link.id, pairingRetries + 1);
        const delay = isPairing ? Math.min(2_000 * 2 ** pairingRetries, 30_000) : 5_000;
        log.warn({ linkId: link.id, code, delay }, "reconnecting whatsapp session…");
        await updateLink(link.id, { status: "pending" });
        setTimeout(() => void startSession(link, onConnected), delay);
      } else {
        log.error({ linkId: link.id }, "session logged out — marking disconnected");
        pairingPhones.delete(link.id);
        const w = pairingWaiters.get(link.id);
        if (w) { pairingWaiters.delete(link.id); w(null); }
        await updateLink(link.id, { status: "disconnected" });
      }
    }
  });

  return sock;
}


/** Phone normalization — proven in nexmint-wa-bot: digits only, KE fixes. */
/** Wipe one link's auth folder — next pairing gets a fresh device identity. */
export function resetSession(linkId: string): void {
  fs.rmSync(`${dataDir}/${linkId}`, { recursive: true, force: true });
}

/** Wipe ALL auth folders (admin op). Returns count of folders removed. */
export function wipeAllSessions(): number {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dataDir)) {
      fs.rmSync(`${dataDir}/${name}`, { recursive: true, force: true });
      n++;
    }
  } catch { /* empty or missing dir */ }
  return n;
}

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
 * API path for pairing (nexmint-wa-bot pattern): set pairing state, start the
 * session, and await the code issued by the connection handler. Mid-pairing
 * drops auto-reconnect and re-issue a FRESH code without user action.
 */
export async function startPairing(
  userId: string,
  phoneE164: string
): Promise<{ linkId: string; pairingCode: string; phone: string }> {
  const { data: existing } = await db
    .from("bot_links")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  let link = (existing as BotLink | null) ?? null;

  if (link?.status === "connected") throw new Error("ALREADY_LINKED");

  const digits = normalizePhone(phoneE164);
  if (!digits) throw new Error("BAD_PHONE");
  const canonical = `+${digits}`; // normalized E.164 — the UI shows the exact number

  if (!link) {
    const { data: created, error } = await db
      .from("bot_links")
      .insert({ user_id: userId, platform: "whatsapp", status: "pending", phone_e164: canonical })
      .select()
      .single();
    if (error) throw error;
    link = created as BotLink;
  } else {
    await db
      .from("bot_links")
      .update({ status: "pending", phone_e164: canonical, pairing_code: null, updated_date: new Date().toISOString() })
      .eq("id", link.id);
    link = { ...link, status: "pending", phone_e164: canonical };
  }

  // Re-pairing a previously-linked row (or a phone change): clear ALL auth
  // state for this link so the session pairs the NEW number, not the old one.
  const stale = sessions.get(link.id);
  sessions.delete(link.id);
  try {
    stale?.end(new Error("re-pairing"));
  } catch {
    // ignore
  }
  if (link.status === "disconnected" || (existing as BotLink | null)?.phone_e164 !== canonical) {
    fs.rmSync(`${dataDir}/${link.id}`, { recursive: true, force: true });
  }

  pairingPhones.set(link.id, digits);

  const code = await new Promise<string | null>((resolve) => {
    pairingWaiters.set(link.id, resolve);
    void startSession(link, async () => {}).catch((e) => {
      log.error({ err: String(e) }, "startSession failed during pairing");
      resolve(null);
    });
    setTimeout(() => {
      if (pairingWaiters.has(link.id)) {
        pairingWaiters.delete(link.id);
        resolve(null);
      }
    }, 45_000);
  });

  if (!code) {
    pairingPhones.delete(link.id);
    throw new Error("PAIR_FAILED");
  }
  return { linkId: link.id, pairingCode: code, phone: canonical };
}

/** Boot-time: bring back every previously connected session. */
export async function restoreSessions(onConnected: OnConnected) {
  const { data } = await db.from("bot_links").select("*").eq("status", "connected");
  for (const l of (data ?? []) as BotLink[]) {
    log.info({ linkId: l.id, phone: l.phone_e164 }, "restoring whatsapp session…");
    void startSession(l, onConnected).catch((e) =>
      log.error({ linkId: l.id, err: String(e) }, "restore failed"));
  }
}

/** Send a chat broadcast to a linked group: text, or image with caption. */
export async function sendToGroup(
  sock: WASocket,
  groupRef: string,
  message: string,
  media?: { url: string; mimetype?: string } | null
): Promise<boolean> {
  try {
    const content = media?.url
      ? { image: { url: media.url }, caption: message || undefined }
      : { text: message };
    const sent = await sock.sendMessage(groupRef, content);
    rememberSent(groupRef, sent?.key?.id ?? undefined, sent?.message);
    return true;
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "group send failed");
    return false;
  }
}

/** Chat broadcast as an ad CARD: framed interactive message with a
 * green "Chat on WhatsApp" CTA button (native flow cta_url), exactly like
 * the UI preview. Falls back to plain text at the caller if it bounces. */
/* ── GUARANTEED-DELIVERY "card": text + wa.me link preview ─────────
 * WhatsApp's server silently drops native interactive cards from
 * consumer accounts (proven via receipts: no server ack, group AND dm).
 * A plain text message with the wa.me URL renders as a framed,
 * tappable "Chat on WhatsApp" preview card and cannot be dropped. */
export async function sendLinkCard(
  sock: WASocket,
  groupRef: string,
  caption: string,
  ctaUrl: string
): Promise<{ ok: boolean; id?: string }> {
  try {
    const body = `📣 ReachNet Broadcast\n\n${caption.trim()}\n\nChat with the marketer 👇\n${ctaUrl}`;
    const msg = await sock.sendMessage(groupRef, { text: body });
    if (msg?.key?.id) {
      rememberSent(groupRef, msg.key.id, msg.message);
      traceReceipt(msg.key.id, groupRef);
    }
    return { ok: true, id: (msg?.key?.id as string) ?? undefined };
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "link card send failed");
    return { ok: false };
  }
}

export async function sendAdCard(
  sock: WASocket,
  groupRef: string,
  caption: string,
  ctaUrl: string,
  media?: { url: string; mimetype?: string } | null,
  envelope: "v1" | "v2" | "bare" = "v1"
): Promise<{ ok: boolean; id?: string }> {
  try {
    let header: Record<string, unknown>;
    if (media?.url) {
      const gen = (await generateWAMessageContent(
        { image: { url: media.url } },
        { upload: sock.waUploadToServer } as never
      )) as { imageMessage?: unknown };
      header = {
        title: "📣 ReachNet Broadcast",
        subtitle: "Tap the button below to chat",
        hasMediaAttachment: true,
        imageMessage: gen.imageMessage,
      };
    } else {
      header = {
        title: "📣 ReachNet Broadcast",
        subtitle: "Tap the button below to chat",
        hasMediaAttachment: false,
      };
    }
    const payload = {
      interactive: {
        header: header as never,
        body: { text: caption?.trim() || " " },
        footer: { text: "ReachNet · Group Broadcast" },
        nativeFlowMessage: {
          buttons: [
            {
              name: "cta_url",
              buttonParamsJson: JSON.stringify({
                display_text: "Chat on WhatsApp",
                url: ctaUrl,
                merchant_url: ctaUrl,
              }),
            },
          ],
          // real Meta cards carry a version on the native flow — without it
          // the server may reject the message as an unknown flow format
          messageVersion: 3,
        },
      },
    };
    // sock.sendMessage's generateWAMessageContent has no branch for the
    // top-level "interactive" key in this Baileys version — it falls through
    // to prepareWAMessageMedia and throws "Invalid media type". Build the
    // Message proto ourselves and relay it directly instead.
    // Real WhatsApp Web wraps interactive messages in a viewOnce envelope
    // with messageContextInfo — a bare interactiveMessage is SILENTLY DROPPED
    // by the servers. v1 = viewOnceMessage, v2 = viewOnceMessageV2.
    const inner = {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
      },
      interactiveMessage: payload.interactive,
    };
    const wrapped =
      envelope === "v2"
        ? { viewOnceMessageV2: { message: inner } }
        : envelope === "bare"
          ? { interactiveMessage: payload.interactive }
          : { viewOnceMessage: { message: inner } };
    return await relayRaw(sock, groupRef, wrapped);
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "ad card send failed");
    return { ok: false };
  }
}

/** Relay a raw pre-built WAMessage (content map) to a group. */
export async function relayRaw(
  sock: WASocket,
  groupRef: string,
  content: Record<string, unknown>
): Promise<{ ok: boolean; id?: string }> {
  try {
    const selfId = sock.user?.id ?? "";
    const msgId = generateMessageIDV2(selfId);
    const fullMsg = generateWAMessageFromContent(
      groupRef,
      content as never,
      { userJid: selfId, messageId: msgId }
    );
    rememberSent(groupRef, fullMsg.key.id ?? msgId, fullMsg.message);
    traceReceipt(fullMsg.key.id ?? msgId, groupRef);
    await sock.relayMessage(groupRef, fullMsg.message as never, {
      messageId: fullMsg.key.id ?? msgId,
    });
    return { ok: true, id: (fullMsg.key.id as string) ?? msgId };
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "raw relay failed");
    return { ok: false };
  }
}

/** A/B TEST: plain text through the SAME relayMessage path — isolates
 * whether relayMessage itself delivers to groups on this session. */
export async function sendTextViaRelay(
  sock: WASocket,
  groupRef: string,
  text: string
): Promise<{ ok: boolean; id?: string }> {
  return relayRaw(sock, groupRef, { conversation: text });
}

/** A/B TEST: hydratedTemplateMessage — the classic ad card (image + text +
 * footer + URL button), an older established type that most clients render. */
export async function sendTemplateCard(
  sock: WASocket,
  groupRef: string,
  caption: string,
  ctaUrl: string
): Promise<boolean> {
  const content = {
    templateMessage: {
      hydratedFourRowTemplate: {
        hydratedContentText: caption,
        hydratedFooterText: "ReachNet · Group Broadcast",
        hydratedButtons: [
          {
            urlButton: {
              displayText: "Chat on WhatsApp",
              url: ctaUrl,
              merchantUrl: ctaUrl,
            },
            index: 1,
          },
        ],
      },
    },
  };
  const r = await relayRaw(sock, groupRef, content);
  return r.ok;
}

/* ── WhatsApp GROUP STATUS broadcast (the "green ring") ──────────
 * Ported from the proven nexmint-wa-bot protocol (24 days, zero
 * bans). Two-step, mirroring WhatsApp Web's own group status flow:
 *   1. Post ONE status to status@broadcast whose audience is the
 *      flattened, deduped member JIDs of the target groups
 *      (statusJidList), with a meta/mentioned_users node listing
 *      the group JIDs — in audience CHUNKS so Baileys' per-member
 *      USync device queries stay small and never hit the 60s
 *      timeout.
 *   2. For each group, relay a groupStatusMessageV2 into the group —
 *      this renders the status card in the group chat and puts the
 *      ring on the group icon. Media is uploaded ONCE and
 *      referenced by every relay.
 */

const STATUS_BG_DEFAULT = "#075E54"; // WhatsApp teal
const STATUS_FONT_DEFAULT = 2;
const STATUS_CHUNK = 400; // members per status@broadcast post

export async function sendGroupStatus(
  sock: WASocket,
  groups: Array<{ group_ref: string; name: string }>,
  caption: string,
  media?: { url: string; mimetype?: string } | null
): Promise<{ sent: number; failed: number; error?: string }> {
  if (!sock.user) return { sent: 0, failed: groups.length, error: "session not connected" };

  // 1) Audience: deduped member JIDs of all target groups + self
  const audience = new Set<string>([jidNormalizedUser(sock.user.id)]);
  const groupJids: string[] = [];
  for (const g of groups) {
    try {
      const meta = await sock.groupMetadata(g.group_ref);
      groupJids.push(g.group_ref);
      for (const p of meta.participants ?? []) audience.add(jidNormalizedUser(p.id));
    } catch (e) {
      log.warn({ groupRef: g.group_ref, err: String(e) }, "groupMetadata failed — group skipped from status audience");
    }
  }
  if (groupJids.length === 0) return { sent: 0, failed: groups.length, error: "no group metadata" };
  const statusJidList = [...audience];

  // 2) Build the status content ONCE (single media upload, reused by all relays)
  const content = media?.url
    ? { image: { url: media.url }, caption: caption || undefined }
    : { text: caption };
  const contentOpts: Record<string, unknown> = { upload: sock.waUploadToServer };
  if (!media?.url) {
    contentOpts.backgroundColor = STATUS_BG_DEFAULT;
    contentOpts.font = STATUS_FONT_DEFAULT;
  }
  const waContent = await generateWAMessageContent(content, contentOpts as never);
  const contentMsg = (waContent as { message?: unknown }).message ?? waContent;

  // 3) Post the status to status@broadcast in audience chunks
  const metaNodes = [
    {
      tag: "meta",
      attrs: {},
      content: [
        {
          tag: "mentioned_users",
          attrs: {},
          content: groupJids.map((gjid) => ({ tag: "to", attrs: { jid: jidNormalizedUser(gjid) } })),
        },
      ],
    },
  ];
  for (let i = 0; i < statusJidList.length; i += STATUS_CHUNK) {
    const chunk = statusJidList.slice(i, i + STATUS_CHUNK);
    const msg = generateWAMessageFromContent("status@broadcast", contentMsg as never, {
      userJid: sock.user.id,
      messageId: generateMessageIDV2(sock.user.id),
    });
    if (!msg.message || !msg.key?.id) throw new Error("failed to build status message");
    // "not-acceptable" / "Timed Out" here means WhatsApp is flow-controlling the
    // account — back off and retry honestly instead of hammering.
    let chunkOk = false;
    const BACKOFFS = [30_000, 60_000];
    for (let attempt = 0; attempt <= BACKOFFS.length && !chunkOk; attempt++) {
      try {
        await sock.relayMessage("status@broadcast", msg.message, {
          messageId: msg.key.id,
          statusJidList: chunk,
          additionalNodes: metaNodes as never,
        });
        chunkOk = true;
      } catch (e) {
        const em = e instanceof Error ? e.message : String(e);
        if (attempt < BACKOFFS.length) {
          log.warn({ attempt: attempt + 1, err: em }, "status chunk throttled — backing off");
          await sleep(BACKOFFS[attempt]);
        } else {
          throw new Error(
            `${em} (WhatsApp is rate-limiting status posts on this number — benched this run; chat broadcasts are unaffected)`
          );
        }
      }
    }
    log.info({ chunk: Math.floor(i / STATUS_CHUNK) + 1, members: chunk.length }, "status chunk posted");
    if (i + STATUS_CHUNK < statusJidList.length) await sleep(5_000);
  }

  // 4) Per-group status message: relays the same generated content into
  //    each group — renders the card + puts the ring on the group icon.
  let sent = 0;
  let failed = 0;
  for (const gjid of groupJids) {
    try {
      const v2 = {
        groupStatusMessageV2: { message: contentMsg },
      } as never;
      await sock.relayMessage(gjid, v2, { messageId: generateMessageIDV2(sock.user.id) });
      sent++;
    } catch (e) {
      failed++;
      log.error({ gjid, err: String(e) }, "group status relay failed");
    }
    await sleep(1_500); // pacing between relays
  }
  log.info({ sent, failed, audience: statusJidList.length, groups: groupJids.length }, "group status finished");
  return { sent, failed };
}
