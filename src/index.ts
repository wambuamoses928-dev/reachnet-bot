import express from "express";
import pino from "pino";
import { restoreSessions, sessions } from "./wa.js";
import { startTelegram } from "./tg.js";
import { setTelegramBot, startBroadcastPoller } from "./broadcast.js";

const log = pino({ name: "main" });

async function main() {
  // 1. Healthcheck endpoint (Railway healthcheck + basic ops surface)
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      whatsappSessions: sessions.size,
      uptime: process.uptime(),
    });
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => log.info({ port }, "healthcheck listening"));

  // 2. Telegram
  const tg = startTelegram();
  setTelegramBot(tg);

  // 3. Restore all previously-linked WhatsApp sessions (multi-session Baileys)
  await restoreSessions(async (linkId, sock) => {
    // re-sync groups on each reconnect so ReachNet's UI stays current
    const { syncAllGroups } = await import("./wa.js");
    await syncAllGroups(linkId, sock).catch(() => {});
  });

  // 4. Broadcast queue
  startBroadcastPoller();

  log.info("reachnet-bot up");
}

main().catch((e) => {
  log.error({ err: String(e) }, "fatal startup error");
  process.exit(1);
});
