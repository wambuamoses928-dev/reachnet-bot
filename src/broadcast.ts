import pino from "pino";
import { randomInt } from "node:crypto";
import {
  db,
  enabledGroupsForUser,
  fetchQueuedBroadcasts,
  updateBroadcast,
} from "./store.js";
import { sendToGroup, sendAdCard, sendGroupStatus, sessions, sendTextViaRelay, sendTemplateCard } from "./wa.js";
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

/** Hard timeout wrapper — a single stuck send must never freeze the poller. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
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
      if (tgBot) {
        ok = await withTimeout(
          sendToTelegramGroup(tgBot, g.group_ref, content),
          120_000,
          `telegram send to ${g.name}`
        ).catch(() => false);
        await delay(humanGap());
      }
      ok ? (statusSent = statusSent + 1) : (statusFailed = statusFailed + 1);
      (results.perGroup as Array<{ group: string; ok: boolean }>).push({ group: g.name, ok });
    }

    results.sent = statusSent;
    results.failed = statusFailed;
    if (statusError) results.error = statusError;
  } else {
    // ── CHAT MODE: per-group messages, text or image+caption, human-paced
    for (const g of groups) {
      let ok = false;
      let attempted = false;
      if (g.platform === "whatsapp") {
        const sock = sessions.get(g.link_id);
        if (sock) {
          attempted = true;
          // framed ad card with the green "Chat on WhatsApp" button; if the
          // interactive payload bounces, fall back to plain text with the
          // click-to-chat link spelled out
          const phone = g.link?.phone_e164?.replace(/[^\d]/g, "");
          const cta = phone
            ? `https://wa.me/${phone}?text=${encodeURIComponent("Hello, can I get more information on this")}`
            : null;
          const mediaArg = media?.url ? { url: media.url, mimetype: media.mimetype } : null;
          // A/B diagnostics: content prefixes force a specific sender so we
          // can identify which payload type WhatsApp actually delivers.
          let variant: "auto" | "v2" | "template" | "relaytest" | "dmcard" = "auto";
          let body = content;
          if (content.startsWith("CARDV2:")) {
            variant = "v2"; body = content.slice(8).trim();
          } else if (content.startsWith("TEMPLATE:")) {
            variant = "template"; body = content.slice(9).trim();
          } else if (content.startsWith("RELAYTEST:")) {
            variant = "relaytest"; body = content.slice(10).trim();
          } else if (content.startsWith("DMCARD:")) {
            variant = "dmcard"; body = content.slice(7).trim();
          }
          if (variant === "relaytest") {
            ok = await withTimeout(
              sendTextViaRelay(sock, g.group_ref, body),
              120_000,
              `whatsapp relay test to ${g.name}`
            ).catch(() => false);
          } else if (variant === "template" && cta) {
            ok = await withTimeout(
              sendTemplateCard(sock, g.group_ref, body, cta),
              120_000,
              `whatsapp template card to ${g.name}`
            ).catch(() => false);
          } else if (variant === "dmcard" && cta) {
            // send the interactive card to the linked account's own DM
            // ("Message yourself") — tests whether interactive cards are
            // group-blocked but deliver person-to-person
            const dmJid = `${phone}@s.whatsapp.net`;
            ok = await withTimeout(
              sendAdCard(sock, dmJid, body, cta, null, "v1"),
              120_000,
              `whatsapp dm card to ${g.name}`
            ).catch(() => false);
          } else if (cta) {
            ok = await withTimeout(
              sendAdCard(sock, g.group_ref, body, cta, mediaArg, variant === "v2" ? "v2" : "v1"),
              120_000,
              `whatsapp card to ${g.name}`
            ).catch(() => false);
          }
          if (!ok) {
            const plain = cta && !/wa\.me/i.test(body)
              ? `${body}\n\nChat on WhatsApp 👉 ${cta}`
              : body;
            ok = await withTimeout(
              sendToGroup(sock, g.group_ref, plain, mediaArg),
              120_000,
              `whatsapp send to ${g.name}`
            ).catch(() => false);
          }
        }
      } else if (g.platform === "telegram" && tgBot) {
        attempted = true;
        ok = await withTimeout(
          sendToTelegramGroup(tgBot, g.group_ref, content),
          120_000,
          `telegram send to ${g.name}`
        ).catch(() => false);
      }
      ok ? (results.sent = (results.sent as number) + 1) : (results.failed = (results.failed as number) + 1);
      (results.perGroup as Array<{ group: string; ok: boolean }>).push({
        group: g.name,
        ok,
      });
      // human pacing only after a real send attempt — dead sessions don't
      // need 47s waits that freeze the whole queue behind them
      if (attempted) await delay(humanGap());
    }
  }

  const status = results.failed === 0 ? "done" : results.sent === 0 ? "failed" : "partial";
  await updateBroadcast(broadcastId, { status, stats: results });
  log.info({ broadcastId, status, mode: mode ?? "chat", sent: results.sent, failed: results.failed }, "broadcast finished");
}

/** A worker restart or a hang can leave rows stuck in "sending" forever.
 * Anything older than 30 minutes in that state is marked failed — the user
 * can re-send from the UI. (Not requeued: some groups may already have got it.) */
async function recoverStaleSending() {
  const cutoff = Date.now() - 30 * 60_000;
  const { data, error } = await db
    .from("broadcasts")
    .select("id, updated_date")
    .eq("status", "sending");
  if (error) return;
  const stale = (data ?? []).filter((r: { id: string; updated_date: string }) => {
    const t = Date.parse(r.updated_date);
    return Number.isFinite(t) && t < cutoff;
  });
  for (const r of stale) {
    log.warn({ broadcastId: r.id }, "marking stale 'sending' broadcast as failed");
    await updateBroadcast(r.id, {
      status: "failed",
      stats: { error: "timed out while sending (worker restarted or send hung) — safe to re-send" },
    }).catch(() => {});
  }
}

/** Poll the broadcasts queue. ReachNet's UI writes 'queued' rows; we do the rest. */
export function startBroadcastPoller() {
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await recoverStaleSending();
      const queued = await fetchQueuedBroadcasts();
      for (const b of queued) {
        try {
          await withTimeout(processOne(b), 25 * 60_000, `broadcast ${b.id}`);
        } catch (e) {
          log.error({ broadcastId: b.id, err: String(e) }, "broadcast crashed/timed out");
          await updateBroadcast(b.id, {
            status: "failed",
            stats: { error: String(e).slice(0, 500) },
          }).catch(() => {});
        }
      }
    } catch (e) {
      log.error({ err: String(e) }, "broadcast poll failed");
    } finally {
      running = false; // ALWAYS reset — a stuck run must not starve the queue
    }
  }, intervalMs);

  log.info({ intervalMs }, "broadcast poller started");
}
