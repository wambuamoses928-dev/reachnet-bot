import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  DisconnectReason,
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
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  });

  sock.ev.on("creds.update", saveCreds);

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

      if (shouldReconnect) {
        log.warn({ linkId: link.id, code }, "reconnecting whatsapp session…");
        await updateLink(link.id, { status: "pending" });
        setTimeout(() => void startSession(link, onConnected), 5_000);
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

/** Send text to a linked group (used by the broadcast worker). */
export async function sendToGroup(
  sock: WASocket,
  groupRef: string,
  message: string
): Promise<boolean> {
  try {
    await sock.sendMessage(groupRef, { text: message });
    return true;
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "group send failed");
    return false;
  }
}
