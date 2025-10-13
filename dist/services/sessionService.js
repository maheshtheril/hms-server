"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSessionBySid = findSessionBySid;
exports.touchSession = touchSession;
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
    return rows[0] || null;
}
// optional: bump last_seen; safe to ignore failures
async function touchSession(sid) {
    try {
        await db_1.default.query(`update sessions set last_seen = now() where sid = $1`, [sid]);
    }
    catch { }
}
