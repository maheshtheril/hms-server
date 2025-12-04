// server/src/lib/session.ts
import crypto from "crypto";
import type { QueryResult } from "pg";
import { q } from "../db";

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

// Accept multiple env names for compatibility. Priority:
// 1) SESSION_COOKIE_NAME
// 2) COOKIE_NAME_SID
// 3) COOKIE_NAME (legacy)
export const COOKIE_NAME =
  (process.env.SESSION_COOKIE_NAME ||
    process.env.COOKIE_NAME_SID ||
    process.env.COOKIE_NAME ||
    "sid").toString();

/**
 * Resolve cookie domain:
 *  - Prefer SESSION_COOKIE_DOMAIN or COOKIE_DOMAIN if set
 *  - Otherwise, if running on Render and hostname ends with .onrender.com,
 *    default to ".onrender.com" so cookies work across services
 *  - Otherwise return empty string (host-only cookie)
 */
function resolveCookieDomain(): string {
  const fromEnv =
    (process.env.SESSION_COOKIE_DOMAIN ||
      process.env.COOKIE_DOMAIN ||
      "").toString().trim();
  if (fromEnv) return fromEnv;

  const hostEnv =
    (process.env.RENDER_EXTERNAL_HOSTNAME ||
      process.env.BACKEND_URL ||
      process.env.BACKEND_HOST ||
      "").toString().trim();

  if (!hostEnv) return "";

  try {
    const url = hostEnv.includes("://") ? new URL(hostEnv) : new URL(`https://${hostEnv}`);
    const hostname = url.hostname;
    if (hostname.endsWith(".onrender.com")) {
      return ".onrender.com";
    }
    return "";
  } catch {
    return "";
  }
}

const COOKIE_DOMAIN = resolveCookieDomain();
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * ISSUE a new session to DB (SID).
 * Uses `absolute_expiry` DB column (existing schema).
 */
export async function issueSession(
  userId: string,
  tenantId?: string | null,
  companyId?: string | null
): Promise<string> {
  const sid = crypto.randomUUID();

  await q(
    `INSERT INTO sessions (sid, user_id, tenant_id, company_id, created_at, last_seen, absolute_expiry)
     VALUES ($1, $2, $3, $4, now(), now(), now() + make_interval(secs => $5))`,
    [sid, userId, tenantId ?? null, companyId ?? null, SESSION_TTL_SECONDS]
  );

  return sid;
}

/**
 * Typed input for createSession
 */
export type CreateSessionInput = {
  userId: string;
  tenantId?: string | null;
  companyId?: string | null;
};

/**
 * createSession wrapper used in routes.
 */
export async function createSession(input: CreateSessionInput): Promise<string> {
  const { userId, tenantId, companyId } = input;
  return issueSession(userId, tenantId ?? null, companyId ?? null);
}

/**
 * Build Set-Cookie header string for the session.
 * Use this with: res.setHeader("Set-Cookie", buildSessionCookie(sid))
 *
 * Behavior:
 *  - In production: SameSite=None + Secure (required for cross-site cookies)
 *  - In non-production: SameSite=Lax (developer-friendly)
 *  - Cookie name is from COOKIE_NAME (defaults to "sid")
 *  - Domain is set if resolved (e.g., ".onrender.com")
 */
export function buildSessionCookie(sid: string): string {
  if (!sid) throw new Error("buildSessionCookie: missing sid");
  const maxAge = SESSION_TTL_SECONDS;
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();

  // Core parts (in this order for readability)
  const parts: string[] = [];
  parts.push(`${COOKIE_NAME}=${encodeURIComponent(sid)}`);
  parts.push(`Path=/`);
  parts.push(`HttpOnly`);
  parts.push(`Max-Age=${Math.floor(maxAge)}`); // seconds
  parts.push(`Expires=${expires}`);

  // Security / SameSite
  if (IS_PROD) {
    parts.push(`SameSite=None`);
    parts.push(`Secure`);
  } else {
    parts.push(`SameSite=Lax`);
    // keep Secure off in dev so local http setups work
  }

  // Domain if resolved
  if (COOKIE_DOMAIN) {
    parts.push(`Domain=${COOKIE_DOMAIN}`);
  }

  return parts.join("; ");
}

/**
 * Build a Set-Cookie header value which clears the session cookie.
 * Use for logout: res.setHeader("Set-Cookie", buildClearSessionCookie());
 */
export function buildClearSessionCookie(): string {
  const expires = new Date(0).toUTCString(); // epoch
  const parts: string[] = [];
  parts.push(`${COOKIE_NAME}=; Path=/`);
  parts.push(`HttpOnly`);
  parts.push(`Max-Age=0`);
  parts.push(`Expires=${expires}`);
  if (IS_PROD) {
    parts.push(`SameSite=None`);
    parts.push(`Secure`);
  } else {
    parts.push(`SameSite=Lax`);
  }
  if (COOKIE_DOMAIN) parts.push(`Domain=${COOKIE_DOMAIN}`);
  return parts.join("; ");
}

/**
 * Touch last_seen (update last_seen timestamp)
 */
export async function touchSession(sid: string): Promise<void> {
  try {
    await q("UPDATE sessions SET last_seen = now() WHERE sid = $1", [sid]);
  } catch (err) {
    console.error("[session.touchSession] error:", err);
    throw err;
  }
}

/**
 * Fetch session (only non-expired).
 * Returns the session row (including absolute_expiry) or null.
 */
export async function getSession(sid: string): Promise<any | null> {
  if (!sid) return null;

  const { rows }: QueryResult = await q(
    `SELECT * FROM sessions
     WHERE sid = $1
       AND (absolute_expiry IS NULL OR absolute_expiry > now())
     LIMIT 1`,
    [sid]
  );
  return rows[0] ?? null;
}

/**
 * Revoke session
 */
export async function revokeSession(sid: string): Promise<void> {
  if (!sid) return;
  await q("DELETE FROM sessions WHERE sid = $1", [sid]);
}

/**
 * Revoke all for a user
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await q("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export default {
  issueSession,
  createSession,
  buildSessionCookie,
  buildClearSessionCookie,
  touchSession,
  getSession,
  revokeSession,
  revokeAllSessionsForUser,
  SESSION_TTL_SECONDS,
  COOKIE_NAME,
  COOKIE_DOMAIN,
};
