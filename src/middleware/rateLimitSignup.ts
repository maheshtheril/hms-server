// server/src/middleware/rateLimitSignup.ts
/**
 * Simple signup rate limiter middleware utility.
 *
 * - Returns: Promise<{ ok: boolean; retryAfter?: number }>
 * - Toggle off with env RATE_LIMIT_SIGNUP=0 (default: enabled)
 * - Window: 60 seconds, Max attempts: 10 (opinionated sane defaults)
 *
 * Notes:
 * - This is an in-memory limiter (per-process). For multiple-server setups use Redis.
 * - Keys are based on req.ip (falls back to header X-Forwarded-For).
 */

import type { Request } from "express";

type RateResult = { ok: true } | { ok: false; retryAfter: number };

const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_SIGNUP !== "0"; // default: enabled
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000); // 60s
const MAX_ATTEMPTS = Number(process.env.RATE_LIMIT_MAX_ATTEMPTS || 10);

// internal store: ip -> { first: epoch_ms, count: number }
const store = new Map<
  string,
  { first: number; count: number }
>();

// lightweight cleanup every minute to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, v] of store.entries()) {
    if (now - v.first > WINDOW_MS * 2) store.delete(key);
  }
}, Math.max(30_000, WINDOW_MS));

/**
 * Primary exported function used in signup handler:
 * const rl = await rateLimitSignup(req);
 * if (rl && rl.ok === false) return res.status(429).json({ error: 'too_many_attempts', retryAfter: rl.retryAfter });
 */
export default async function rateLimitSignup(req: Request): Promise<RateResult> {
  if (!RATE_LIMIT_ENABLED) return { ok: true };

  // get client identifier
  let ip = getRequestIP(req);
  if (!ip) ip = "unknown";

  const now = Date.now();
  const entry = store.get(ip);

  if (!entry) {
    store.set(ip, { first: now, count: 1 });
    return { ok: true };
  }

  // same window?
  if (now - entry.first <= WINDOW_MS) {
    entry.count += 1;
    // update map (object mutated but do explicit set for safety)
    store.set(ip, entry);

    if (entry.count > MAX_ATTEMPTS) {
      const retryAfterSeconds = Math.ceil((WINDOW_MS - (now - entry.first)) / 1000);
      return { ok: false, retryAfter: retryAfterSeconds };
    }

    return { ok: true };
  }

  // window expired -> reset
  store.set(ip, { first: now, count: 1 });
  return { ok: true };
}

/* helper: try to get most-accurate client ip */
function getRequestIP(req: Request): string | null {
  // X-Forwarded-For may be a comma-separated list
  const xff = (req.headers["x-forwarded-for"] as string) || (req.headers["x-forwarded-for"] as string | undefined);
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[0];
  }
  // fallback to connection ip
  // @ts-ignore - express/types differences
  if ((req as any).ip) return (req as any).ip;
  // common fallback properties
  // @ts-ignore
  if (req.connection && (req.connection as any).remoteAddress) return (req.connection as any).remoteAddress;
  // last fallback
  return null;
}
