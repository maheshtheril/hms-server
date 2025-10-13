import type { Response } from "express";

const secure = process.env.NODE_ENV !== "development";
const base = {
  httpOnly: true,
  sameSite: "none" as const, // required for cross-site cookies
  secure,                    // Secure flag in non-dev
  path: "/",
  domain: process.env.COOKIE_DOMAIN,
};

export function setCookie(res: Response, name: string, val: string) {
  res.cookie(name, val, base);
}

export function clearCookie(res: Response, name: string) {
  res.clearCookie(name, base);
}
