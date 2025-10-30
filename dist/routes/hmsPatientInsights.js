"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/hmsPatientInsights.ts
const express_1 = __importDefault(require("express"));
const requireAuth_1 = require("../middleware/requireAuth");
const db_1 = __importDefault(require("../db"));
const patientInsights_1 = require("../services/patientInsights");
const router = express_1.default.Router();
router.use(requireAuth_1.requireAuth);
/**
 * GET /api/hms/patients/:id/insights
 * - returns cached insights (if any)
 */
router.get("/patients/:id/insights", async (req, res, next) => {
    try {
        const tenant_id = req.user.tenant_id;
        const patient_id = req.params.id;
        const r = await db_1.default.query(`SELECT * FROM public.hms_patient_insights WHERE tenant_id=$1 AND patient_id=$2 LIMIT 1`, [tenant_id, patient_id]);
        if (!r.rows.length)
            return res.status(404).json({ error: "insights_not_found" });
        res.json(r.rows[0]);
    }
    catch (err) {
        next(err);
    }
});
/**
 * POST /api/hms/patients/:id/insights/compute
 * - triggers compute & store (sync)
 * - in heavy load you can call this from a background job instead (we keep sync for now)
 */
router.post("/patients/:id/insights/compute", async (req, res, next) => {
    try {
        const tenant_id = req.user.tenant_id;
        const patient_id = req.params.id;
        // fetch patient
        const pr = await db_1.default.query(`SELECT * FROM public.hms_patient WHERE id=$1 AND tenant_id = $2 LIMIT 1`, [patient_id, tenant_id]);
        if (!pr.rows.length)
            return res.status(404).json({ error: "patient_not_found" });
        const patient = pr.rows[0];
        const insights = await (0, patientInsights_1.computeAndStoreInsights)(patient);
        res.json(insights);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
