"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const requireAuth_1 = require("../middleware/requireAuth");
const router = (0, express_1.Router)();
function ensureTenant(req) {
    const s = req.session;
    if (!s?.tenant_id)
        throw new Error("tenant_missing");
    return s.tenant_id;
}
/**
 * GET /api/pipelines
 * List pipelines for current tenant
 */
router.get("/pipelines", requireAuth_1.requireAuth, async (req, res) => {
    const tenantId = ensureTenant(req);
    const { rows } = await (0, db_1.q)(`SELECT id, name
       FROM public.pipeline
      WHERE tenant_id = $1
      ORDER BY created_at ASC`, [tenantId]);
    res.json(rows);
});
/**
 * GET /api/pipelines/:id/stages
 * List stages for a given pipeline
 */
router.get("/pipelines/:id/stages", requireAuth_1.requireAuth, async (req, res) => {
    const { id } = req.params;
    const { rows } = await (0, db_1.q)(`SELECT id, key, name, sort_order, is_won, is_lost
       FROM public.pipeline_stage
      WHERE pipeline_id = $1
      ORDER BY sort_order ASC, created_at ASC`, [id]);
    res.json(rows);
});
/**
 * GET /api/kanban/:pipelineId
 * Fetch board columns and leads grouped by stage
 */
router.get("/kanban/:pipelineId", requireAuth_1.requireAuth, async (req, res) => {
    const tenantId = ensureTenant(req);
    const { pipelineId } = req.params;
    const stages = await (0, db_1.q)(`SELECT ps.id, ps.name, ps.key, ps.sort_order, ps.is_won, ps.is_lost
       FROM public.pipeline_stage ps
      WHERE ps.pipeline_id = $1
      ORDER BY ps.sort_order ASC, ps.created_at ASC`, [pipelineId]);
    const leads = await (0, db_1.q)(`SELECT l.id, l.name, l.stage_id, l.estimated_value,
            l.owner_id, l.updated_at, l.position,
            au.name AS owner_name, au.email AS owner_email,
            l.probability
       FROM public.lead l
  LEFT JOIN public.app_user au ON au.id = l.owner_id
      WHERE l.tenant_id = $1 AND l.pipeline_id = $2
      ORDER BY COALESCE(l.position, 0) ASC, l.updated_at DESC`, [tenantId, pipelineId]);
    const cols = stages.rows.map(s => ({ ...s, leads: [] }));
    const map = new Map(cols.map(c => [String(c.id), c]));
    for (const L of leads.rows) {
        map.get(String(L.stage_id))?.leads.push(L);
    }
    res.json({ columns: cols });
});
/**
 * POST /api/kanban/reorder
 * Persist new ordering within a column (stage)
 */
router.post("/kanban/reorder", requireAuth_1.requireAuth, async (req, res) => {
    const tenantId = ensureTenant(req);
    const { stage_id, ordered_ids } = req.body || {};
    if (!stage_id || !Array.isArray(ordered_ids)) {
        return res.status(400).json({ error: "bad_request" });
    }
    // Update positions in bulk
    const updates = ordered_ids.map((id, idx) => (0, db_1.q)(`UPDATE public.lead
          SET position = $1
        WHERE id = $2
          AND stage_id = $3
          AND tenant_id = $4`, [idx, id, stage_id, tenantId]));
    await Promise.all(updates);
    res.json({ ok: true });
});
exports.default = router;
