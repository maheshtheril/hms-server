import crypto from "crypto";
import { q } from "../db";

/**
 * Create and issue a new session for a user.
 */
export async function issueSession(userId: string, tenantId?: string | null) {
  const sid = crypto.randomUUID();
  await q(
    "INSERT INTO sessions (sid, user_id, tenant_id) VALUES ($1, $2, $3)",
    [sid, userId, tenantId ?? null]
  );
  return sid;
}

/**
 * Update the last_seen timestamp for an active session.
 */
export async function touchSession(sid: string) {
  await q("UPDATE sessions SET last_seen = now() WHERE sid = $1", [sid]);
}

/**
 * Fetch session row (joined in routes to include user info).
 */
export async function getSession(sid: string) {
  const { rows } = await q("SELECT * FROM sessions WHERE sid = $1", [sid]);
  return rows[0] ?? null;
}

/**
 * Revoke (delete) a session by id.
 */
export async function revokeSession(sid: string) {
  await q("DELETE FROM sessions WHERE sid = $1", [sid]);
}
