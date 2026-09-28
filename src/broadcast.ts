import pino from "pino";
import { randomInt } from "node:crypto";
import {
  db,
  enabledGroupsForUser,
  fetchQueuedBroadcasts,
  updateBroadcast,
} from "./store.js";
import { sendToGroup, sessions } from "./wa.js";
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

async function processOne(broadcastId: string, userId: string, content: string) {
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
    perGroup: [] as Array<{ group: string; ok: boolean }>,
  };

  for (const g of groups) {
    let ok = false;
    if (g.platform === "whatsapp") {
      const sock = sessions.get(g.link_id);
      if (sock) ok = await sendToGroup(sock, g.group_ref, content);
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

  const status = results.failed === 0 ? "done" : results.sent === 0 ? "failed" : "partial";
  await updateBroadcast(broadcastId, { status, stats: results });
  log.info({ broadcastId, status, ...results }, "broadcast finished");
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
        await processOne(b.id, b.user_id, b.content);
      }
    } catch (e) {
      log.error({ err: String(e) }, "broadcast poll failed");
    } finally {
      running = false;
    }
  }, intervalMs);

  log.info({ intervalMs }, "broadcast poller started");
}
