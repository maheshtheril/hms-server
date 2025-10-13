import db from "../db";

export type SessionRow = {
  sid: string;
  user_id: string;
  tenant_id: string | null;
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
  return rows[0] || null;
}

// optional: bump last_seen; safe to ignore failures
export async function touchSession(sid: string): Promise<void> {
  try { await db.query(`update sessions set last_seen = now() where sid = $1`, [sid]); } catch {}
}
