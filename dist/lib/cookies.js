"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setCookie = setCookie;
exports.clearCookie = clearCookie;
const secure = process.env.NODE_ENV !== "development";
const base = {
    httpOnly: true,
    sameSite: "none", // required for cross-site cookies
    secure, // Secure flag in non-dev
    path: "/",
    domain: process.env.COOKIE_DOMAIN,
};
function setCookie(res, name, val) {
    res.cookie(name, val, base);
}
function clearCookie(res, name) {
    res.clearCookie(name, base);
}
