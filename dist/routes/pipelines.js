"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const requireAuth_1 = require("../middleware/requireAuth");
const router = (0, express_1.Router)();
/**
 * GET /api/pipelines/:id/stages
 * Return all stages for a pipeline, ordered.
 */
router.get("/pipelines/:id/stages", requireAuth_1.requireAuth, async (req, res) => {
    const { id } = req.params;
    const { rows } = await (0, db_1.q)(`SELECT id, key, name, sort_order, is_won, is_lost
       FROM public.lead_stage
      WHERE pipeline_id = $1
      ORDER BY sort_order ASC, created_at ASC`, [id]);
    res.json(rows);
});
exports.default = router;
