// src/lib/cookies.ts
import type { Response } from "express";

export const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

/**
 * IMPORTANT:
 * For Render multi-subdomain setups, you MUST set:
 *   COOKIE_DOMAIN=.onrender.com
 *
 * Otherwise cookies will be host-only and never reach frontend.
 */
const COOKIE_DOMAIN =
  process.env.COOKIE_DOMAIN?.trim() || ".onrender.com"; // <-- FIXED

export function setCookie(res: Response, name: string, value: string) {
  res.cookie(name || COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,        // Always true on HTTPS (Render)
    sameSite: "none",    // Required for cross-site cookies
    domain: COOKIE_DOMAIN,
    path: "/",
    maxAge: 30 * 24 * 3600 * 1000, // 30 days
  });
}

export function clearCookie(res: Response, name: string) {
  res.clearCookie(name || COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    domain: COOKIE_DOMAIN,
    path: "/",
  });
}
