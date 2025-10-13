"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueSession = issueSession;
exports.touchSession = touchSession;
exports.getSession = getSession;
exports.revokeSession = revokeSession;
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../db");
/**
 * Create and issue a new session for a user.
 */
async function issueSession(userId, tenantId) {
    const sid = crypto_1.default.randomUUID();
    await (0, db_1.q)("INSERT INTO sessions (sid, user_id, tenant_id) VALUES ($1, $2, $3)", [sid, userId, tenantId ?? null]);
    return sid;
}
/**
 * Update the last_seen timestamp for an active session.
 */
async function touchSession(sid) {
    await (0, db_1.q)("UPDATE sessions SET last_seen = now() WHERE sid = $1", [sid]);
}
/**
 * Fetch session row (joined in routes to include user info).
 */
async function getSession(sid) {
    const { rows } = await (0, db_1.q)("SELECT * FROM sessions WHERE sid = $1", [sid]);
    return rows[0] ?? null;
}
/**
 * Revoke (delete) a session by id.
 */
async function revokeSession(sid) {
    await (0, db_1.q)("DELETE FROM sessions WHERE sid = $1", [sid]);
}
