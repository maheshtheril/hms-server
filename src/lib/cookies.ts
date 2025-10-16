// lib/cookies.ts
import type { Response } from "express";

export function setCookie(res: Response, name: string, value: string) {
  // Only set Domain when explicitly provided; otherwise let it default to host.
  const domain = process.env.COOKIE_DOMAIN?.trim() || undefined;

  res.cookie(name, value, {
    httpOnly: true,
    secure: true,          // Render uses HTTPS
    sameSite: "none",      // cross-site allowed
    path: "/",             // must cover /auth/me
    ...(domain ? { domain } : {}), // <-- remove Domain=localhost in prod
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

export function clearCookie(res: Response, name: string) {
  const domain = process.env.COOKIE_DOMAIN?.trim() || undefined;
  res.clearCookie(name, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    ...(domain ? { domain } : {}),
  });
}
