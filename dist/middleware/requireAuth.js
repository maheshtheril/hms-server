"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const session_1 = require("../lib/session");
/**
 * Middleware to ensure a request is authenticated.
 * - Reads the session ID from cookie (sid by default).
 * - Validates it against the sessions table.
 * - Refreshes last_seen timestamp.
 * - Attaches session info to req.session.
 */
async function requireAuth(req, res, next) {
    const sid = req.cookies?.[process.env.COOKIE_NAME_SID || "sid"];
    if (!sid) {
        return res.status(401).json({ error: "unauthenticated" });
    }
    const s = await (0, session_1.getSession)(sid);
    if (!s) {
        return res.status(401).json({ error: "session_expired" });
    }
    await (0, session_1.touchSession)(sid);
    req.session = s;
    next();
}
