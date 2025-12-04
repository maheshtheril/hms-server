// src/middleware/requireAuth.ts
import { RequestHandler } from "express";
import { q } from "../db";

/**
 * Policy:
 * - INACTIVITY_MS: how long since last_seen before we treat session as inactive.
 *   Set long enough for normal usage. Default = 30 days.
 * - If you want stricter inactivity rules, lower this value intentionally.
 */
const INACTIVITY_MS = Number(process.env.SESSION_INACTIVITY_MS) || 30 * 24 * 60 * 60 * 1000; // 30 days

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

export const requireAuth: RequestHandler = async (req: any, res, next) => {
  try {
    // 1) Read sid from cookie OR Authorization header (Bearer)
    const sidFromCookie = req.cookies?.[COOKIE_NAME];
    let sid = sidFromCookie;
    if (!sid) {
      const authHeader = (req.headers?.authorization || "") as string;
      if (authHeader.startsWith("Bearer ")) sid = authHeader.slice(7).trim();
    }

    // 2) If still no sid, respond 401
    if (!sid) {
      console.warn("requireAuth: no sid present", { path: req.path, host: req.headers.host, origin: req.headers.origin });
      return res.status(401).json({ error: "unauthenticated" });
    }

    // 3) Lookup session row (defensive: support varying q() return shapes)
    const sql = `
      SELECT sid, user_id, tenant_id, company_id, issued_at, last_seen, absolute_expiry, meta
      FROM public.sessions
      WHERE sid = $1
      LIMIT 1
    `;
    const raw = await q(sql, [sid]);
    // q() may return { rows } or an array — normalize
    const rows = Array.isArray(raw) ? raw : (raw && (raw.rows || raw));
    const session = rows?.[0];

    if (!session) {
      console.warn("requireAuth: session_missing", { sid, path: req.path, host: req.headers.host });
      return res.status(401).json({ error: "unauthenticated" });
    }

    const now = Date.now();

    // 4) absolute_expiry check (use actual column from your schema)
    if (session.absolute_expiry) {
      const expiryMs = new Date(session.absolute_expiry).getTime();
      if (!isNaN(expiryMs) && expiryMs < now) {
        console.warn("requireAuth: session_expired absolute_expiry", { sid, absolute_expiry: session.absolute_expiry });
        return res.status(401).json({ error: "session_expired" });
      }
    }

    // 5) inactivity check (only reject if last_seen older than INACTIVITY_MS)
    if (session.last_seen) {
      const lastSeenMs = new Date(session.last_seen).getTime();
      if (!isNaN(lastSeenMs) && now - lastSeenMs > INACTIVITY_MS) {
        console.warn("requireAuth: session_inactive", { sid, last_seen: session.last_seen, INACTIVITY_MS });
        return res.status(401).json({ error: "session_inactive" });
      }
    }

    // 6) Touch last_seen (best-effort async update, but we'll await so DB reflects activity quickly)
    q(`UPDATE public.sessions SET last_seen = now() WHERE sid = $1`, [sid]).catch((e) => {
      console.error("requireAuth: touch last_seen failed", e?.message || e);
    });

    // 7) Attach session to req in a consistent shape your routes expect
    req.authSession = {
      sid: session.sid,
      user_id: session.user_id,
      company_id: session.company_id,
      tenant_id: session.tenant_id,
      meta: session.meta
    };
    req.userId = session.user_id;
    req.companyId = session.company_id;

    return next();
  } catch (err) {
    console.error("requireAuth error:", err);
    return res.status(500).json({ error: "server_error" });
  }
};

export default requireAuth;
