"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setCookie = setCookie;
exports.clearCookie = clearCookie;
const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";
/**
 * In production, DO NOT set a Domain unless explicitly provided by env.
 * Let it default to the current host.
 */
function setCookie(res, name, value) {
    const domain = process.env.COOKIE_DOMAIN?.trim() || undefined; // only set if explicitly defined
    res.cookie(name || COOKIE_NAME, value, {
        httpOnly: true,
        secure: true, // production: HTTPS
        sameSite: "none", // cross-site cookies
        path: "/",
        ...(domain ? { domain } : {}),
        maxAge: 30 * 24 * 3600 * 1000, // 30 days
    });
}
function clearCookie(res, name) {
    const domain = process.env.COOKIE_DOMAIN?.trim() || undefined;
    res.clearCookie(name || COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        ...(domain ? { domain } : {}),
    });
}
