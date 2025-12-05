// src/middleware/requireAuth.ts
import type { RequestHandler } from "express";
import { q } from "../db";

/**
 * Policy:
 * - INACTIVITY_MS: how long since last_seen before we treat session as inactive.
 *   Default = 30 days.
 */
const INACTIVITY_MS = Number(process.env.SESSION_INACTIVITY_MS) || 30 * 24 * 60 * 60 * 1000; // 30 days

// Accept a variety of cookie env names for compatibility
const COOKIE_NAME =
  (process.env.SESSION_COOKIE_NAME ||
    process.env.COOKIE_NAME_SID ||
    process.env.COOKIE_NAME ||
    "sid")
    .toString();

/** Helper: robustly extract a sid from cookie/header/query/body */
function getSidFromReq(req: any): string | null {
  try {
    // 1) cookie (httpOnly preferred)
    if (req.cookies && req.cookies[COOKIE_NAME]) {
      return String(req.cookies[COOKIE_NAME]);
    }
  } catch (e) {
    // ignore cookie parse errors
  }

  try {
    // 2) Authorization: Bearer <sid>
    const authHeader = (req.headers?.authorization || "") as string;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) return token;
    }

    // 3) X-Session-Id header (explicit)
    if (req.headers && req.headers["x-session-id"]) {
      return String(req.headers["x-session-id"]);
    }

    // 4) fallback: body or query (useful for curl/testing)
    if (req.body && req.body.sid) return String(req.body.sid);
    if (req.query && req.query.sid) return String(req.query.sid);
  } catch (e) {
    // ignore
  }

  return null;
}

/** Normalize q() result into rows array safely */
function normalizeRows(raw: any): any[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (raw.rows && Array.isArray(raw.rows)) return raw.rows;
  // Some q implementations return an object with numeric keys
  try {
    return Array.from(raw);
  } catch {
    return null;
  }
}

export const requireAuth: RequestHandler = async (req: any, res, next) => {
  try {
    // Helpful debug info when troubleshooting cross-site cookie issues
    const debugInfo = {
      path: req.path,
      origin: req.headers.origin,
      host: req.headers.host,
      forwardedProto: req.headers["x-forwarded-proto"],
      reqSecure: Boolean(req.secure),
    };

    const sid = getSidFromReq(req);

    if (!sid) {
      console.warn("requireAuth: no sid present", debugInfo);
      return res.status(401).json({ error: "unauthenticated" });
    }

    // Lookup session
    const sql = `
      SELECT sid, user_id, tenant_id, company_id, issued_at, last_seen, absolute_expiry, meta
      FROM public.sessions
      WHERE sid = $1
      LIMIT 1
    `;
    const raw = await q(sql, [sid]);
    const rows = normalizeRows(raw);
    const session = rows?.[0];

    if (!session) {
      console.warn("requireAuth: session_missing", { sid, ...debugInfo });
      return res.status(401).json({ error: "unauthenticated" });
    }

    const now = Date.now();

    // absolute_expiry check
    if (session.absolute_expiry) {
      const expiryMs = new Date(session.absolute_expiry).getTime();
      if (!isNaN(expiryMs) && expiryMs < now) {
        console.warn("requireAuth: session_expired (absolute_expiry)", { sid, absolute_expiry: session.absolute_expiry });
        return res.status(401).json({ error: "session_expired" });
      }
    }

    // inactivity check
    if (session.last_seen) {
      const lastSeenMs = new Date(session.last_seen).getTime();
      if (!isNaN(lastSeenMs) && now - lastSeenMs > INACTIVITY_MS) {
        console.warn("requireAuth: session_inactive", { sid, last_seen: session.last_seen, INACTIVITY_MS });
        return res.status(401).json({ error: "session_inactive" });
      }
    }

    // Touch last_seen (best-effort, non-blocking)
    (async () => {
      try {
        await q(`UPDATE public.sessions SET last_seen = now() WHERE sid = $1`, [sid]);
      } catch (e: any) {
        console.error("requireAuth: touch last_seen failed", e?.message || e);
      }
    })();

    // Attach session to req in a consistent shape
    req.authSession = {
      sid: session.sid,
      user_id: session.user_id,
      company_id: session.company_id,
      tenant_id: session.tenant_id,
      meta: session.meta ?? null,
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
