// server/src/routes/activities.ts
import { Router } from "express";
import { q } from "../db";
import { requireSession } from "../lib/session-mw";

const router = Router();

/**
 * GET /api/activities?for=today&limit=6
 * Minimal: return recent activities for current tenant user.
 */
router.get("/", requireSession, async (req, res) => {
  try {
    const me: any = req.user;
    const tenantId = me?.tenant_id || me?.tenant?.id || null;
    // If no tenant, return empty list (avoid 404 for logged out / platform admin flows)
    if (!tenantId) return res.json({ activities: [] });

    const forParam = String(req.query.for || "today");
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 6)));

    // Simple example: query activities table — adapt columns to your schema
    const { rows } = await q(
      `SELECT id, type, summary, due_at, created_at
         FROM activity
        WHERE tenant_id = $1
          AND deleted_at IS NULL
          AND ( ($2 = 'today' AND DATE(due_at) = CURRENT_DATE) OR $2 <> 'today' )
        ORDER BY due_at NULLS LAST, created_at DESC
        LIMIT $3`,
      [tenantId, forParam, limit]
    );

    return res.json({ activities: rows || [] });
  } catch (err) {
    console.error("GET /api/activities error:", err);
    return res.status(500).json({ error: "activities_failed" });
  }
});

export default router;
