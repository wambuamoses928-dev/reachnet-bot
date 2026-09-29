import express, { type Request, type Response, type NextFunction } from "express";
import pino from "pino";
import { db, type BotLink } from "./store.js";
import { sessions, startPairing, syncAllGroups, resetSession, wipeAllSessions, sendAdCard, sendToGroup, sendTextViaRelay, sendLinkCard, sendImageCard } from "./wa.js";
import { runSql } from "./sql.js";

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

  // ── DEBUG: send a test ad card to ONE group (service-key guarded).
  // Used to iterate on card delivery without touching broadcast state.
  app.post("/debug/card", async (req: Request, res: Response) => {
    const auth = (req.headers["x-debug-key"] as string | undefined) ?? "";
    if (!SERVICE_KEY || auth !== SERVICE_KEY) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { name, caption, url, envelope, asText, asLink, asImage, imageUrl } = (req.body ?? {}) as {
      name?: string; caption?: string; url?: string; envelope?: "v1" | "v2" | "bare"; asText?: boolean; asLink?: boolean; asImage?: boolean; imageUrl?: string;
    };
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    try {
      const { data, error } = await db
        .from("linked_groups")
        .select("id, group_ref, link_id, name")
        .eq("name", name)
        .eq("platform", "whatsapp")
        .limit(5);
      if (error || !data?.length) {
        res.status(404).json({ error: error?.message ?? "group not found" });
        return;
      }
      const results: Array<Record<string, unknown>> = [];
      for (const g of data) {
        const sock = sessions.get(g.link_id);
        if (!sock) { results.push({ group: g.name, ok: false, error: "no session" }); continue; }
        const cta = url ?? "https://wa.me/254700000000";
        const sent = asImage
          ? await sendImageCard(sock, g.group_ref, imageUrl ?? "https://media.base44.com/images/public/6a7af065faa7f6636d17f4d8/cfaff1ba9_generated_image.png", caption ?? "ReachNet image card", cta)
          : asLink
          ? await sendLinkCard(sock, g.group_ref, caption ?? "ReachNet link card", cta)
          : asText
          ? await sendTextViaRelay(sock, g.group_ref, caption ?? "ReachNet text relay control")
          : await sendAdCard(
              sock,
              g.group_ref,
              caption ?? "ReachNet test card",
              cta,
              null,
              envelope ?? "v1"
            );
        results.push({ group: g.name, groupRef: g.group_ref, ok: sent.ok, id: sent.id });
      }
      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── DEBUG: send a test ad card to the linked account's OWN DM.
  app.post("/debug/dm-card", async (req: Request, res: Response) => {
    const auth = (req.headers["x-debug-key"] as string | undefined) ?? "";
    if (!SERVICE_KEY || auth !== SERVICE_KEY) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { caption, url, envelope, asText, asLink, asImage, imageUrl } = (req.body ?? {}) as {
      caption?: string; url?: string; envelope?: "v1" | "v2" | "bare"; asText?: boolean; asLink?: boolean; asImage?: boolean; imageUrl?: string;
    };
    for (const [linkId, sock] of sessions) {
      // resolve the account's own phone JID (LID-independent)
      const candidates: string[] = [];
      const me = (sock as unknown as { authState?: { creds?: { me?: unknown } } })
        .authState?.creds?.me;
      if (typeof me === "string") candidates.push(me);
      else if (me && typeof me === "object") {
        const o = me as { id?: unknown; lid?: unknown };
        if (typeof o.id === "string") candidates.push(o.id);
        if (typeof o.lid === "string") candidates.push(o.lid);
      }
      const su = (sock as unknown as { user?: { id?: unknown } }).user;
      if (su && typeof su.id === "string") candidates.push(su.id);
      const raw = candidates.find((c) => c.includes("@s.whatsapp.net"))
        ?? candidates[0];
      if (!raw) { res.status(500).json({ error: "could not resolve own jid", candidates }); return; }
      // strip the ":device" suffix — a full JID targets one device (the bot
      // itself); the bare JID delivers to the whole account incl. the phone
      const jid = raw.split(":")[0] + "@s.whatsapp.net";
      if (!jid) { res.status(500).json({ error: "could not resolve own jid", candidates }); return; }
      const cta = url ?? "https://wa.me/254700000000";
      try {
        const sent = asImage
          ? await sendImageCard(sock, jid, imageUrl ?? "https://media.base44.com/images/public/6a7af065faa7f6636d17f4d8/cfaff1ba9_generated_image.png", caption ?? "ReachNet DM image card", cta)
          : asLink
          ? await sendLinkCard(sock, jid, caption ?? "ReachNet DM link card", cta)
          : asText
          ? await sendTextViaRelay(sock, jid, caption ?? "ReachNet DM text test")
          : await sendAdCard(sock, jid, caption ?? "ReachNet DM card test", cta, null, envelope ?? "v1");
        res.json({ linkId, jid, ok: sent.ok, id: sent.id });
        return;
      } catch (e) {
        res.status(500).json({ error: String(e), jid });
        return;
      }
    }
    res.status(503).json({ error: "no active session" });
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, whatsappSessions: sessions.size, uptime: process.uptime() });
  });

  // Start (or restart) WhatsApp pairing for the logged-in user.
  app.post("/link/whatsapp/start", async (req, res) => {
    const uid = await userFrom(req, res);
    if (!uid) return;
    // Accept local formats too — normalizePhone (nexmint-wa-bot pattern) is
    // the single source of truth: 07xx…, 7xx…, +254…, 254… all work.
    const phone = String(req.body?.phone ?? "").trim();
    if (phone.replace(/\D/g, "").length < 9) {
      res.status(400).json({ error: "Enter your phone number, e.g. +2547XXXXXXXX or 07XXXXXXXX" });
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
      try {
        await db
          .from("bot_debug")
          .insert({ scope: "pairing", message: msg.slice(0, 500), detail: { uid, phone } });
      } catch {
        // debug log is best-effort
      }
      res.status(500).json({
        error: "Could not start pairing. Try again in a minute.",
        detail: msg.slice(0, 160),
      });
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
      const n = await syncAllGroups(link.id, sock, link.user_id);
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

  // ── Pairing reset: wipe THIS user's WhatsApp auth folder so the next
  //    "Get pairing code" starts from a completely fresh device identity.
  //    Used after a pairing attempt was rejected — a poisoned/half-paired
  //    identity folder keeps failing even when the code itself is fine.
  app.post("/link/whatsapp/reset", async (req, res) => {
    const uid = await userFrom(req, res);
    if (!uid) return;
    const link = await myLink(uid);
    if (!link) {
      res.status(404).json({ error: "No WhatsApp link found." });
      return;
    }
    const sock = sessions.get(link.id);
    sessions.delete(link.id);
    try { sock?.end(undefined); } catch { /* already dead */ }
    resetSession(link.id);
    await db.from("bot_links").update({
      status: "disconnected", pairing_code: null, updated_date: new Date().toISOString(),
    }).eq("id", link.id);
    log.info({ uid, linkId: link.id }, "whatsapp session reset — fresh identity on next pairing");
    res.json({ ok: true });
  });

  // ── Ops: run raw SQL against the ReachNet database (ADMIN_SECRET header).
  // Direct DB port is blocked from most sandboxes; the worker has egress.
  // Used for one-time migrations (trigger changes) that PostgREST can't do.
  app.post("/debug/sql", async (req, res) => {
    const secret = process.env.ADMIN_SECRET ?? "";
    if (!secret || req.headers["x-admin-secret"] !== secret) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const { sql } = (req.body ?? {}) as { sql?: string };
      if (!sql || typeof sql !== "string") {
        res.status(400).json({ error: "sql required" });
        return;
      }
      const { rows } = await runSql(sql);
      res.json({ ok: true, rows: rows.slice(0, 20) });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Ops: wipe ALL session folders (ADMIN_SECRET header). Only safe while
  //    no live connected accounts exist; used to clear poisoned pairing
  //    identities after WhatsApp pairing restrictions.
  app.post("/admin/wipe-sessions", (req, res) => {
    const secret = process.env.ADMIN_SECRET ?? "";
    if (!secret || req.header("x-admin-secret") !== secret) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const n = wipeAllSessions();
    log.warn({ wiped: n }, "ALL session folders wiped via admin endpoint");
    res.json({ ok: true, wiped: n });
  });
}
