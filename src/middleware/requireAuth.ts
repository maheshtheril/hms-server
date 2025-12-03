// src/middleware/requireAuth.ts
import { RequestHandler } from "express";
import { q } from "../db";

// Policy: inactivity window and absolute expiry enforcement
const INACTIVITY_MS = 1000 * 60 * 60 * 2; // 2 hours

export const requireAuth: RequestHandler = async (req: any, res, next) => {
  try {
    // 1) Read sid from cookie OR Authorization header (Bearer)
    const sidFromCookie = req.cookies?.sid;
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

    // 3) Lookup session row
    const { rows } = await q(
      `SELECT sid, user_id, tenant_id, company_id, issued_at, last_seen, absolute_expiry, meta
       FROM public.sessions
       WHERE sid = $1
       LIMIT 1`,
      [sid]
    );
    const session = rows?.[0];
    if (!session) {
      console.warn("requireAuth: session_missing", { sid, path: req.path, host: req.headers.host });
      return res.status(401).json({ error: "unauthenticated" });
    }

    const now = Date.now();
    // 4) absolute_expiry check
    if (session.absolute_expiry && new Date(session.absolute_expiry).getTime() < now) {
      console.warn("requireAuth: session_expired absolute_expiry", { sid, absolute_expiry: session.absolute_expiry });
      return res.status(401).json({ error: "session_expired" });
    }

    // 5) inactivity check (last_seen + INACTIVITY_MS < now)
    if (session.last_seen && new Date(session.last_seen).getTime() + INACTIVITY_MS < now) {
      console.warn("requireAuth: session_inactive", { sid, last_seen: session.last_seen });
      return res.status(401).json({ error: "session_inactive" });
    }

    // 6) Touch last_seen (best-effort async update, don't block)
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
