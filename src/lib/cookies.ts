// /server/src/lib/cookies.ts
import type { Response } from "express";

const COOKIE_NAME = process.env.COOKIE_NAME_SID || "sid";

/** production check */
const isProd = () => process.env.NODE_ENV === "production";

/**
 * compute cookie domain:
 * - In prod, prefer explicit COOKIE_DOMAIN env var if it looks like a parent domain (starts with a dot).
 * - Fallback for Render: use ".onrender.com"
 * - In dev (non-prod): return undefined (do NOT set domain)
 */
function cookieDomain(): string | undefined {
  if (!isProd()) return undefined;

  const env = (process.env.COOKIE_DOMAIN || "").trim();
  if (env) {
    // prefer an env value that is a parent domain like ".example.com"
    // allow both ".onrender.com" and "onrender.com" by normalizing
    return env.startsWith(".") ? env : `.${env}`;
  }

  // sensible default for Render deployments
  return ".onrender.com";
}

/**
 * setCookie - sets a session cookie with safe defaults for prod/dev.
 */
export function setCookie(res: Response, name: string, value: string) {
  const cookieName = name || COOKIE_NAME;
  const domain = cookieDomain();

  res.cookie(cookieName, value, {
    httpOnly: true,
    secure: isProd(),                       // require https in production
    sameSite: "none",                       // ALWAYS use None for cross-site session cookies (works in dev if secure false)
    path: "/",
    maxAge: 30 * 24 * 3600 * 1000,          // 30 days
    ...(domain ? { domain } : {}),
  });
}

export function clearCookie(res: Response, name: string) {
  const cookieName = name || COOKIE_NAME;
  const domain = cookieDomain();

  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: isProd(),
    sameSite: "none",
    path: "/",
    ...(domain ? { domain } : {}),
  });
}
