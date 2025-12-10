// server/src/routes/notifications.ts
import { Router } from "express";

const router = Router();

/**
 * Lightweight notifications router stub.
 * - Returns an empty list for GET /notifications
 * - Exposes POST /notifications to accept a create (no-op)
 *
 * Replace with your real logic later.
 */

/** GET /notifications */
router.get("/notifications", async (req, res) => {
  try {
    // TODO: replace with real DB-backed notifications
    return res.json({
      ok: true,
      notifications: [],
    });
  } catch (err: any) {
    console.error("notifications#get error:", err?.message ?? err);
    return res.status(500).json({ error: "server_error" });
  }
});

/** POST /notifications (create) */
router.post("/notifications", async (req, res) => {
  try {
    // receive payload but don't persist in the stub
    const payload = req.body;
    return res.status(201).json({ ok: true, created: payload || null });
  } catch (err: any) {
    console.error("notifications#post error:", err?.message ?? err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
