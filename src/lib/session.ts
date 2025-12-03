// server/src/lib/session.ts
import crypto from "crypto";
import type { QueryResult } from "pg";
import { q } from "../db";

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

// ⚠️ Use a single cookie name everywhere (frontend, middleware, curl, backend)
export const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "sid";

/**
 * Resolve cookie domain:
 * - Prefer SESSION_COOKIE_DOMAIN env if set
 * - Otherwise, if running on Render and hostname ends with .onrender.com,
 *   default to ".onrender.com" so cookies work across hms-server-njlg & hmsweb.
 * - Otherwise no Domain attribute (host-only).
 */
function resolveCookieDomain(): string {
  const fromEnv = (process.env.SESSION_COOKIE_DOMAIN || "").trim();
  if (fromEnv) return fromEnv;

  const hostEnv =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    process.env.BACKEND_URL ||
    "";

  if (!hostEnv) return "";

  try {
    const url =
      hostEnv.includes("://") ? new URL(hostEnv) : new URL(`https://${hostEnv}`);
    const hostname = url.hostname;

    if (hostname.endsWith(".onrender.com")) {
      // ✅ share cookie across all *.onrender.com services
      return ".onrender.com";
    }

    return "";
  } catch {
    return "";
  }
}

const COOKIE_DOMAIN = resolveCookieDomain();

/**
 * ISSUE a new session to DB (SID).
 * Uses `absolute_expiry` DB column (existing schema).
 *
 * absolute_expiry = now() + SESSION_TTL_SECONDS seconds
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
 * This is what you pass to res.setHeader("Set-Cookie", buildSessionCookie(sid))
 *
 * Works for cross-site front/back:
 *   - SameSite=None (in production)
 *   - Secure (in production)
 *   - HttpOnly
 *   - Domain resolves to ".onrender.com" on Render by default
 */
export function buildSessionCookie(sid: string): string {
  const maxAge = SESSION_TTL_SECONDS;
  const isProd = process.env.NODE_ENV === "production";

  // Expires header (HTTP date) for compatibility
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();

  const securePart = isProd ? "; Secure" : "";
  const sameSitePart = isProd ? "; SameSite=None" : "; SameSite=Lax";

  const domainPart = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : "";

  // 👉 Name is COOKIE_NAME = "sid" (unless overridden by env)
  return `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; Max-Age=${maxAge}; Expires=${expires}${securePart}${sameSitePart}${domainPart}`;
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
  touchSession,
  getSession,
  revokeSession,
  revokeAllSessionsForUser,
  SESSION_TTL_SECONDS,
  COOKIE_NAME,
};
