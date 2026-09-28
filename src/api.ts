import express, { type Request, type Response, type NextFunction } from "express";
import pino from "pino";
import { db, type BotLink } from "./store.js";
import { sessions, startPairing, syncAllGroups } from "./wa.js";

const log = pino({ name: "api" });

// Browser origins allowed to call this API (ReachNet frontend).
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ??
  "https://reachnet.vercel.app,https://reachnet.vercel.app,http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** Verify a ReachNet user's Supabase JWT and return their auth uid. */
async function verifyUser(token: string | undefined): Promise<string | null> {
  if (!token || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = (await r.json()) as { id?: string };
    return user.id ?? null;
  } catch (e) {
    log.error({ err: String(e) }, "token verification failed");
    return null;
  }
}

async function userFrom(req: Request, res: Response): Promise<string | null> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || (req.body?.token as string | undefined);
  const uid = await verifyUser(token);
  if (!uid) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return uid;
}

async function myLink(uid: string): Promise<BotLink | null> {
  const { data } = await db
    .from("bot_links")
    .select("*")
    .eq("user_id", uid)
    .eq("platform", "whatsapp")
    .maybeSingle();
  return (data as BotLink) ?? null;
}

export function registerApi(app: express.Express) {
  app.use(express.json({ limit: "256kb" }));

  // CORS — only for the ReachNet frontend origins.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, whatsappSessions: sessions.size, uptime: process.uptime() });
  });

  // Start (or restart) WhatsApp pairing for the logged-in user.
  app.post("/link/whatsapp/start", async (req, res) => {
    const uid = await userFrom(req, res);
    if (!uid) return;
    const phone = String(req.body?.phone ?? "").trim();
    if (!/^\+\d{8,15}$/.test(phone)) {
      res.status(400).json({ error: "Phone must be in international format, e.g. +2547XXXXXXXX" });
      return;
    }
    try {
      const out = await startPairing(uid, phone);
      log.info({ uid, linkId: out.linkId }, "pairing started via API");
      res.json(out);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("ALREADY_LINKED")) {
        res.status(409).json({ error: "This account already has a connected WhatsApp link." });
        return;
      }
      log.error({ uid, err: msg }, "pairing failed");
      res.status(500).json({ error: "Could not start pairing. Try again in a minute." });
    }
  });

  // Force a group re-sync for the user's connected link.
  app.post("/link/whatsapp/refresh", async (req, res) => {
    const uid = await userFrom(req, res);
    if (!uid) return;
    const link = await myLink(uid);
    const sock = link ? sessions.get(link.id) : undefined;
    if (!link || link.status !== "connected" || !sock) {
      res.status(409).json({ error: "WhatsApp is not connected." });
      return;
    }
    try {
      const n = await syncAllGroups(link.id, sock);
      res.json({ ok: true, groups: n });
    } catch (e) {
      log.error({ uid, err: String(e) }, "group refresh failed");
      res.status(500).json({ error: "Sync failed. Try again shortly." });
    }
  });

  // Disconnect the user's WhatsApp link.
  app.post("/link/whatsapp/disconnect", async (req, res) => {
    const uid = await userFrom(req, res);
    if (!uid) return;
    const link = await myLink(uid);
    if (!link) {
      res.status(404).json({ error: "No WhatsApp link found." });
      return;
    }
    const sock = sessions.get(link.id);
    sessions.delete(link.id);
    try {
      await sock?.logout();
    } catch {
      // socket may already be dead — ignore
    }
    await db.from("bot_links").update({ status: "disconnected", pairing_code: null, updated_date: new Date().toISOString() }).eq("id", link.id);
    log.info({ uid, linkId: link.id }, "whatsapp disconnected via API");
    res.json({ ok: true });
  });
}
