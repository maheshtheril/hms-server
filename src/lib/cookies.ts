// server/src/lib/cookies.ts
import type { Response } from "express";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

function isProd() {
  return process.env.NODE_ENV === "production";
}

/**
 * setCookie - sets a session cookie with safe defaults for prod/dev.
 */
export function setCookie(res: Response, name: string, value: string) {
  const cookieName = name || COOKIE_NAME;
  const domain = (process.env.COOKIE_DOMAIN || "").trim() || undefined;

  res.cookie(cookieName, value, {
    httpOnly: true,
    secure: isProd(),                       // only require https in production
    sameSite: isProd() ? "none" : "lax",    // none for cross-site in prod, lax locally
    path: "/",
    maxAge: 30 * 24 * 3600 * 1000,          // 30 days
    ...(domain ? { domain } : {}),
  });
}

export function clearCookie(res: Response, name: string) {
  const cookieName = name || COOKIE_NAME;
  const domain = (process.env.COOKIE_DOMAIN || "").trim() || undefined;

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: isProd(),
    sameSite: isProd() ? "none" : "lax",
    path: "/",
    ...(domain ? { domain } : {}),
  });
}
