import { Router, Request, Response } from "express";

const router = Router();

/**
 * Minimal debug endpoint that NEVER touches DB.
 * It only logs the cookie and returns safe JSON.
 */
router.get("/me", (req: Request, res: Response) => {
  try {
    const cookieNames = Object.keys(req.cookies || {});
    const sid =
      req.cookies?.sid ||
      req.cookies?.erp_session ||
      req.cookies?.[process.env.SESSION_COOKIE_NAME || "sid"] ||
      null;

    console.info("[DEBUG /api/me] HIT");
    console.info("[DEBUG /api/me] Cookies:", cookieNames);
    console.info("[DEBUG /api/me] SID:", sid ? sid.substring(0, 8) + "…" : "NONE");

    return res.status(200).json({
      ok: true,
      debug: {
        sid: sid ? "present" : "none",
        cookies: cookieNames,
      },
    });
  } catch (err: any) {
    console.error("[DEBUG /api/me] ERROR:", err.message);
    return res.status(200).json({
      ok: true,
      debug: { error: err.message || "unknown error" },
    });
  }
});

export default router;
