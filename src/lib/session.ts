// server/src/lib/session.ts
import crypto from "crypto";
import type { QueryResult } from "pg";
import { q } from "../db";

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days
export const COOKIE_NAME = "erp_session";

/**
 * ISSUE a new session to DB (SID).
 * Now supports companyId.
 *
 * Uses `absolute_expiry` DB column (existing schema) instead of `expires_at`.
 */
export async function issueSession(
  userId: string,
  tenantId?: string | null,
  companyId?: string | null
): Promise<string> {
  const sid = crypto.randomUUID();

  // Store absolute_expiry = now() + ttl
  await q(
    `INSERT INTO sessions (sid, user_id, tenant_id, company_id, created_at, last_seen, absolute_expiry)
     VALUES ($1, $2, $3, $4, now(), now(), now() + ($5 || ' seconds')::interval)`,
    [sid, userId, tenantId ?? null, companyId ?? null, SESSION_TTL_SECONDS]
  );

  return sid;
}

/**
 * createSession wrapper used in routes.
 */
export async function createSession({
  userId,
  tenantId,
  companyId,
}: {
  userId: string;
  tenantId?: string | null;
  companyId?: string | null;
}): Promise<string> {
  return issueSession(userId, tenantId ?? null, companyId ?? null);
}

/**
 * Build Set-Cookie header string for the session.
 * Always returns a single string (safe and simple for res.setHeader).
 */
export function buildSessionCookie(sid: string): string {
  const maxAge = SESSION_TTL_SECONDS;
  const isProd = process.env.NODE_ENV === "production";

  // Expires header (HTTP date) for compatibility with some clients
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();

  // In production we set Secure and SameSite=None to allow cross-site usage (if you need it),
  // but ensure you serve over HTTPS. For non-prod we use SameSite=Lax and no Secure so local dev works.
  const securePart = isProd ? "; Secure" : "";
  const sameSitePart = isProd ? "; SameSite=None" : "; SameSite=Lax";

  // Optional Domain attribute: you can set via env if you host under a known domain
  const cookieDomain = process.env.SESSION_COOKIE_DOMAIN
    ? `; Domain=${process.env.SESSION_COOKIE_DOMAIN}`
    : "";

  return `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; Max-Age=${maxAge}; Expires=${expires}${securePart}${sameSitePart}${cookieDomain}`;
}

/**
 * Touch last_seen
 */
export async function touchSession(sid: string): Promise<void> {
  await q("UPDATE sessions SET last_seen = now() WHERE sid = $1", [sid]);
}

/**
 * Fetch session
 *
 * Returns the session row (including absolute_expiry) or null.
 * NOTE: callers may want to check absolute_expiry to reject expired sessions.
 */
export async function getSession(sid: string): Promise<any | null> {
  const { rows }: QueryResult = await q(
    "SELECT * FROM sessions WHERE sid = $1",
    [sid]
  );
  return rows[0] ?? null;
}

/**
 * Revoke session
 */
export async function revokeSession(sid: string): Promise<void> {
  await q("DELETE FROM sessions WHERE sid = $1", [sid]);
}

/**
 * Revoke all for a user (optional)
 */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await q("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
