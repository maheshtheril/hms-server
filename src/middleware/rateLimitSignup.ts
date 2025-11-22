// server/src/middleware/rateLimitSignup.ts
import type { IncomingMessage } from "http";
import Redis from "ioredis";

/**
 * Rate limit response types.
 * TS can fully narrow these in your signup handler.
 */
export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number };

/**
 * Signup Rate Limiting Policy:
 * - 3 attempts per minute
 * - 10 attempts per hour
 * Uses Redis when REDIS_URL is provided; otherwise in-memory fallback.
 */

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || "";
const USE_REDIS = Boolean(REDIS_URL);

const HOURLY_LIMIT = Number(process.env.SIGNUP_HOURLY_LIMIT ?? 10);
const MINUTE_LIMIT = Number(process.env.SIGNUP_MINUTE_LIMIT ?? 3);

const HOUR_WINDOW = 60 * 60;     // seconds
const MINUTE_WINDOW = 60;        // seconds

let redis: Redis | null = null;

if (USE_REDIS) {
  redis = new Redis(REDIS_URL);
  redis.on("error", (err) => {
    console.error("[rateLimitSignup] Redis error:", err);
  });
}

/* =======================================================================
   In-memory fallback (used only when redis not available)
   ======================================================================= */

type MemEntry = {
  timestamps: number[]; // unix seconds
};

const memoryMap = new Map<string, MemEntry>();
const MEM_CLEAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function cleanupMemory() {
  const cutoff = nowSec() - HOUR_WINDOW;

  for (const [key, entry] of memoryMap.entries()) {
    entry.timestamps = entry.timestamps.filter((t) => t >= cutoff);

    if (entry.timestamps.length === 0) {
      memoryMap.delete(key);
    }
  }
}

setInterval(cleanupMemory, MEM_CLEAN_INTERVAL_MS);

/* =======================================================================
   Helpers
   ======================================================================= */

function getIpFromReq(req: IncomingMessage): string {
  const xff = (req.headers?.["x-forwarded-for"] as string | undefined) || "";
  if (xff) {
    return xff.split(",")[0].trim();
  }

  // Express compatibility
  // @ts-ignore
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return String(ip);
}

/* =======================================================================
   MAIN FUNCTION
   ======================================================================= */

export async function rateLimitSignup(req: IncomingMessage): Promise<RateLimitResult> {
  const ip = getIpFromReq(req);
  const now = nowSec();

  /* --------------------------------------
     REDIS MODE
     -------------------------------------- */
  if (redis) {
    try {
      const hourKey = `rl:signup:hour:${ip}`;
      const minKey = `rl:signup:min:${ip}`;

      const multi = redis
        .multi()
        .incr(hourKey)
        .expire(hourKey, HOUR_WINDOW)
        .incr(minKey)
        .expire(minKey, MINUTE_WINDOW);

      const results = await multi.exec();

      const hourCount = Number(results?.[0]?.[1] ?? 0);
      const minCount = Number(results?.[2]?.[1] ?? 0);

      if (minCount > MINUTE_LIMIT) {
        const ttl = await redis.ttl(minKey);
        return { ok: false, retryAfter: ttl > 0 ? ttl : MINUTE_WINDOW };
      }

      if (hourCount > HOURLY_LIMIT) {
        const ttl = await redis.ttl(hourKey);
        return { ok: false, retryAfter: ttl > 0 ? ttl : HOUR_WINDOW };
      }

      return { ok: true };

    } catch (err) {
      console.warn("[rateLimitSignup] Redis failed — using in-memory fallback.", err);
      // fall through
    }
  }

  /* --------------------------------------
     IN-MEMORY MODE (dev/single instance)
     -------------------------------------- */

  let entry = memoryMap.get(ip);
  if (!entry) {
    entry = { timestamps: [] };
    memoryMap.set(ip, entry);
  }

  // Keep only last hour
  entry.timestamps = entry.timestamps.filter((t) => t >= now - HOUR_WINDOW);

  const recentMinute = entry.timestamps.filter((t) => t >= now - MINUTE_WINDOW);
  const recentHour = entry.timestamps;

  if (recentMinute.length >= MINUTE_LIMIT) {
    const earliest = Math.min(...recentMinute);
    const retryAfter = MINUTE_WINDOW - (now - earliest);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }

  if (recentHour.length >= HOURLY_LIMIT) {
    const earliest = Math.min(...recentHour);
    const retryAfter = HOUR_WINDOW - (now - earliest);
    return { ok: false, retryAfter: Math.max(1, retryAfter) };
  }

  // record this attempt
  entry.timestamps.push(now);

  return { ok: true };
}

/* Convenience default export */
export default rateLimitSignup;
