// server/src/services/sessionService.ts
import db from "../db";

export type SessionRow = {
  sid: string;
  user_id: string;
  tenant_id: string | null;
  /** Optional company context (derived from meta.company_id if present) */
  company_id?: string | null;
  /** Optional roles (derived from meta.roles if present) */
  roles?: string[] | null;
  device?: string | null;
  issued_at?: string;
  last_seen?: string;
  absolute_expiry?: string | null;
  meta?: any;
};

// look up the session row by sid (and ensure it isn't expired)
export async function findSessionBySid(sid: string): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `
    select sid, user_id, tenant_id, device,
           to_char(issued_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') as issued_at,
           to_char(last_seen, 'YYYY-MM-DD"T"HH24:MI:SSZ')  as last_seen,
           to_char(absolute_expiry, 'YYYY-MM-DD"T"HH24:MI:SSZ') as absolute_expiry,
           meta
      from sessions
     where sid = $1
       and (absolute_expiry is null or absolute_expiry > now())
     limit 1
    `,
    [sid]
  );

  const row = rows[0];
  if (!row) return null;

  // Safely derive optional fields from meta to avoid schema requirements.
  const meta = (row as any).meta ?? null;

  let company_id: string | null = null;
  if (meta && typeof meta === "object" && meta.company_id != null) {
    try {
      company_id = String(meta.company_id);
    } catch {
      company_id = null;
    }
  }

  let roles: string[] | null = null;
  if (meta && typeof meta === "object" && Array.isArray(meta.roles)) {
    roles = meta.roles.map((r: any) => String(r)).filter(Boolean);
  }

  // Return a normalized object that includes optional fields
  return {
    sid: row.sid,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    device: row.device ?? null,
    issued_at: row.issued_at,
    last_seen: row.last_seen,
    absolute_expiry: row.absolute_expiry ?? null,
    meta,
    company_id,
    roles,
  };
}

// optional: bump last_seen; safe to ignore failures
export async function touchSession(sid: string): Promise<void> {
  try {
    await db.query(`update sessions set last_seen = now() where sid = $1`, [sid]);
  } catch {}
}
