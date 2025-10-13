import type { Request, Response, NextFunction } from "express";
import { getSession, touchSession } from "../lib/session";

/**
 * Middleware to ensure a request is authenticated.
 * - Reads the session ID from cookie (sid by default).
 * - Validates it against the sessions table.
 * - Refreshes last_seen timestamp.
 * - Attaches session info to req.session.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
  if (!sid) {
    return res.status(401).json({ error: "unauthenticated" });
  }

  const s = await getSession(sid);
  if (!s) {
    return res.status(401).json({ error: "session_expired" });
  }

  await touchSession(sid);
  (req as any).session = s;
  next();
}
