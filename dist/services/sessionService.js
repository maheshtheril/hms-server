"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSessionBySid = findSessionBySid;
exports.touchSession = touchSession;
// server/src/services/sessionService.ts
const db_1 = __importDefault(require("../db"));
// look up the session row by sid (and ensure it isn't expired)
async function findSessionBySid(sid) {
    const { rows } = await db_1.default.query(`
    select sid, user_id, tenant_id, device,
           to_char(issued_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') as issued_at,
           to_char(last_seen, 'YYYY-MM-DD"T"HH24:MI:SSZ')  as last_seen,
           to_char(absolute_expiry, 'YYYY-MM-DD"T"HH24:MI:SSZ') as absolute_expiry,
           meta
      from sessions
     where sid = $1
       and (absolute_expiry is null or absolute_expiry > now())
     limit 1
    `, [sid]);
    const row = rows[0];
    if (!row)
        return null;
    // Safely derive optional fields from meta to avoid schema requirements.
    const meta = row.meta ?? null;
    let company_id = null;
    if (meta && typeof meta === "object" && meta.company_id != null) {
        try {
            company_id = String(meta.company_id);
        }
        catch {
            company_id = null;
        }
    }
    let roles = null;
    if (meta && typeof meta === "object" && Array.isArray(meta.roles)) {
        roles = meta.roles.map((r) => String(r)).filter(Boolean);
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
async function touchSession(sid) {
    try {
        await db_1.default.query(`update sessions set last_seen = now() where sid = $1`, [sid]);
    }
    catch { }
}
