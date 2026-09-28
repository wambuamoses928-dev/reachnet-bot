import pino from "pino";
import { randomInt } from "node:crypto";
import {
  db,
  enabledGroupsForUser,
  fetchQueuedBroadcasts,
  updateBroadcast,
} from "./store.js";
import { sendToGroup, sendGroupStatus, sessions } from "./wa.js";
import { sendToTelegramGroup } from "./tg.js";

const log = pino({ name: "broadcast" });
let tgBot: Awaited<ReturnType<typeof import("./tg.js").startTelegram>> = null;

export function setTelegramBot(bot: typeof tgBot) {
  tgBot = bot;
}

/** Pacing that kept the old bot alive 24 days:
 *  long randomized gaps between group sends, slight jitter per message. */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function humanGap() {
  return randomInt(25_000, 70_000); // 25-70s between groups
}

type QueuedBroadcast = {
  id: string;
  user_id: string;
  content: string;
  mode?: "chat" | "status" | null;
  media_url?: string | null;
  media_kind?: string | null;
  media_mimetype?: string | null;
};

async function processOne(b: QueuedBroadcast) {
  const { id: broadcastId, user_id: userId, content, mode } = b;
  const media = b.media_url
    ? { url: b.media_url, kind: b.media_kind ?? "image", mimetype: b.media_mimetype ?? undefined }
    : null;
  const groups = await enabledGroupsForUser(userId);
  if (groups.length === 0) {
    await updateBroadcast(broadcastId, {
      status: "failed",
      stats: { error: "no enabled groups" },
    });
    return;
  }

  await updateBroadcast(broadcastId, { status: "sending" });
  const results: Record<string, unknown> = {
    total: groups.length,
    sent: 0,
    failed: 0,
    mode: mode ?? "chat",
    perGroup: [] as Array<{ group: string; ok: boolean }>,
  };

  // ── STATUS MODE (WhatsApp only): one status post per session, relayed into
  //    each group as a group status card. Telegram groups get a normal
  //    message — statuses aren't a thing there.
  if (mode === "status") {
    const waGroups = groups.filter((g) => g.platform === "whatsapp");
    const tgGroups = groups.filter((g) => g.platform === "telegram");
    let statusSent = 0;
    let statusFailed = 0;
    let statusError: string | undefined;

    // one WhatsApp session per link — group targets by their link
    const byLink = new Map<string, typeof waGroups>();
    for (const g of waGroups) {
      const arr = byLink.get(g.link_id) ?? [];
      arr.push(g);
      byLink.set(g.link_id, arr);
    }
    for (const [linkId, gs] of byLink) {
      const sock = sessions.get(linkId);
      if (!sock) {
        statusFailed += gs.length;
        continue;
      }
      try {
        // Give members the "Chat on WhatsApp" path: if the caption has no
        // wa.me link yet, append the marketer's click-to-chat link with the
        // message prefilled — exactly what the UI preview promises.
        let caption = content;
        const phone = gs[0]?.link?.phone_e164?.replace(/[^\d]/g, "");
        if (phone && !/wa\.me/i.test(caption)) {
          const prefill = encodeURIComponent("Hello, can I get more information on this");
          caption += `${caption ? "\n\n" : ""}Chat on WhatsApp 👉 https://wa.me/${phone}?text=${prefill}`;
        }
        const r = await sendGroupStatus(
          sock,
          gs.map((g) => ({ group_ref: g.group_ref, name: g.name })),
          caption,
          media?.url ? { url: media.url, mimetype: media.mimetype } : null
        );
        statusSent += r.sent;
        statusFailed += r.failed;
        if (r.error) statusError = r.error;
      } catch (e) {
        statusFailed += gs.length;
        statusError = String(e);
        log.error({ broadcastId, linkId, err: statusError }, "group status broadcast failed");
      }
    }

    // telegram fallback: plain messages with the usual pacing
    for (const g of tgGroups) {
      let ok = false;
      if (tgBot) ok = await sendToTelegramGroup(tgBot, g.group_ref, content);
      ok ? (statusSent = statusSent + 1) : (statusFailed = statusFailed + 1);
      (results.perGroup as Array<{ group: string; ok: boolean }>).push({ group: g.name, ok });
      await delay(humanGap());
    }

    results.sent = statusSent;
    results.failed = statusFailed;
    if (statusError) results.error = statusError;
  } else {
    // ── CHAT MODE: per-group messages, text or image+caption, human-paced
    for (const g of groups) {
      let ok = false;
      if (g.platform === "whatsapp") {
        const sock = sessions.get(g.link_id);
        if (sock)
          ok = await sendToGroup(
            sock,
            g.group_ref,
            content,
            media?.url ? { url: media.url, mimetype: media.mimetype } : null
          );
      } else if (g.platform === "telegram" && tgBot) {
        ok = await sendToTelegramGroup(tgBot, g.group_ref, content);
      }
      ok ? (results.sent = (results.sent as number) + 1) : (results.failed = (results.failed as number) + 1);
      (results.perGroup as Array<{ group: string; ok: boolean }>).push({
        group: g.name,
        ok,
      });
      await delay(humanGap()); // never machine-gun the groups
    }
  }

  const status = results.failed === 0 ? "done" : results.sent === 0 ? "failed" : "partial";
  await updateBroadcast(broadcastId, { status, stats: results });
  log.info({ broadcastId, status, mode: mode ?? "chat", sent: results.sent, failed: results.failed }, "broadcast finished");
}

/** Poll the broadcasts queue. ReachNet's UI writes 'queued' rows; we do the rest. */
export function startBroadcastPoller() {
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const queued = await fetchQueuedBroadcasts();
      for (const b of queued) {
        await processOne(b);
      }
    } catch (e) {
      log.error({ err: String(e) }, "broadcast poll failed");
    } finally {
      running = false;
    }
  }, intervalMs);

  log.info({ intervalMs }, "broadcast poller started");
}
