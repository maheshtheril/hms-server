// src/lib/cookies.ts
import type { Response } from "express";

export function setCookie(res: Response, name: string, value: string) {
  res.cookie(name || process.env.COOKIE_NAME_SID || "sid", value, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

export function clearCookie(res: Response, name: string) {
  res.clearCookie(name || process.env.COOKIE_NAME_SID || "sid", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}
