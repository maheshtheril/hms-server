// server/src/lib/getSidFromReq.ts
import type { Request } from "express";

const COOKIE_NAME = (process.env.SESSION_COOKIE_NAME ||
  process.env.COOKIE_NAME_SID ||
  process.env.COOKIE_NAME ||
  "sid").toString();

export function getSidFromReq(req: Request): string | null {
  // 1) Prefer HttpOnly cookie
  try {
    if (req.cookies && (req.cookies as any)[COOKIE_NAME]) {
      return String((req.cookies as any)[COOKIE_NAME]);
    }
  } catch (e) {
    // ignore cookie parse errors
  }

  // 2) Authorization: Bearer <sid>
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }

  // 3) X-Session-Id header
  const hdr = req.headers["x-session-id"];
  if (hdr) return String(hdr);

  // 4) fallback: body or query (useful for quick curl tests)
  try {
    if ((req as any).body && (req as any).body.sid) return String((req as any).body.sid);
    if ((req as any).query && (req as any).query.sid) return String((req as any).query.sid);
  } catch (e) {}

  return null;
}
