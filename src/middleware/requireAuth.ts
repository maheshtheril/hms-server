// server/src/middleware/requireAuth.ts
import type { RequestHandler } from "express";
import { q } from "../db";

/**
 * requireAuth middleware
 * - extracts sid from cookies / headers / body / query
 * - validates session existence, absolute expiry, inactivity
 * - updates last_seen (best-effort, non-blocking)
 * - attaches req.authSession and req.user (lightweight) for downstream handlers
 *
 * Behavior: returns 401 for unauthenticated sessions and 500 on server errors.
 */

/* Configuration */
const INACTIVITY_MS = Number(process.env.SESSION_INACTIVITY_MS) || 30 * 24 * 60 * 60 * 1000; // 30 days by default
const COOKIE_NAME =
  (process.env.SESSION_COOKIE_NAME ||
    process.env.COOKIE_NAME_SID ||
    process.env.COOKIE_NAME ||
    "sid")
    .toString();

/* Helper: extract sid */
function getSidFromReq(req: any): string | null {
  try {
    // cookie parsed by cookie-parser middleware
    if (req.cookies && req.cookies[COOKIE_NAME]) {
      return String(req.cookies[COOKIE_NAME]);
    }
  } catch (e) {
    // ignore
  }

  try {
    // Authorization: Bearer <sid>
    const authHeader = (req.headers?.authorization || "") as string;
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) return token;
    }

    // x-session-id header
    if (req.headers && req.headers["x-session-id"]) {
      return String(req.headers["x-session-id"]);
    }

    // fallback: body or query (useful for tests)
    if (req.body && req.body.sid) return String(req.body.sid);
    if (req.query && req.query.sid) return String(req.query.sid);
  } catch (e) {
    // ignore
  }

  return null;
}

/* Normalize q() result */
function normalizeRows(raw: any): any[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (raw.rows && Array.isArray(raw.rows)) return raw.rows;
  return null;
}

/* Safe parse meta */
function parseMeta(meta: any) {
  if (!meta) return null;
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return null;
  }
}

export const requireAuth: RequestHandler = async (req: any, res, next) => {
  try {
    // Helpful debug info (avoid logging sensitive cookies in prod)
    const debugContext = {
      path: req.path,
      origin: req.headers.origin,
      host: req.headers.host,
      secure: Boolean(req.secure),
    };

    const sid = getSidFromReq(req);
    if (!sid) {
      console.warn("requireAuth: missing sid", debugContext);
      return res.status(401).json({ error: "unauthenticated" });
    }

    // Query session (use explicit schema.table to be clear)
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
      console.warn("requireAuth: session not found", { sid: sid.slice(0, 8) + "...", ...debugContext });
      return res.status(401).json({ error: "unauthenticated" });
    }

    // Must have a user_id
    if (!session.user_id) {
      console.warn("requireAuth: session has no user_id", { sid: sid.slice(0, 8) + "...", ...debugContext });
      return res.status(401).json({ error: "unauthenticated" });
    }

    const now = Date.now();

    // absolute_expiry
    if (session.absolute_expiry) {
      const expiryMs = new Date(session.absolute_expiry).getTime();
      if (!isNaN(expiryMs) && expiryMs < now) {
        console.warn("requireAuth: session expired (absolute_expiry)", { sid: sid.slice(0, 8) + "...", absolute_expiry: session.absolute_expiry });
        return res.status(401).json({ error: "session_expired" });
      }
    }

    // inactivity
    if (session.last_seen) {
      const lastSeenMs = new Date(session.last_seen).getTime();
      if (!isNaN(lastSeenMs) && now - lastSeenMs > INACTIVITY_MS) {
        console.warn("requireAuth: session inactive (last_seen)", { sid: sid.slice(0, 8) + "...", last_seen: session.last_seen });
        return res.status(401).json({ error: "session_inactive" });
      }
    }

    // best-effort update last_seen (non-blocking)
    (async () => {
      try {
        await q(`UPDATE public.sessions SET last_seen = now() WHERE sid = $1`, [sid]);
      } catch (e: any) {
        // don't break request if touch fails
        console.debug("requireAuth: failed to touch last_seen:", e?.message || e);
      }
    })();

    // attach auth session
    const meta = parseMeta(session.meta);
    req.authSession = {
      sid: session.sid,
      user_id: session.user_id,
      tenant_id: session.tenant_id ?? null,
      company_id: session.company_id ?? null,
      issued_at: session.issued_at ?? null,
      last_seen: session.last_seen ?? null,
      meta,
    };

    // attach lightweight req.user shape (keeps parity with other middleware)
    req.user = {
      id: String(session.user_id),
    };

    return next();
  } catch (err: any) {
    console.error("requireAuth error:", (err && err.stack) || err);
    return res.status(500).json({ error: "server_error" });
  }
};

export default requireAuth;
