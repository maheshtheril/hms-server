"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const requireAuth_1 = require("../middleware/requireAuth");
const leadsService_1 = require("../services/leadsService");
const router = (0, express_1.Router)();
// Basic payload validator (avoid extra deps); tighten as needed
function assertStr(o, k, required = false) {
    if (!(k in o)) {
        if (required)
            throw new Error(`${k} required`);
        else
            return;
    }
    if (o[k] != null && typeof o[k] !== "string")
        throw new Error(`${k} must be string`);
}
router.post("/leads", requireAuth_1.requireAuth, async (req, res) => {
    try {
        const { userId, tenantId } = req.auth;
        const b = req.body || {};
        // common
        assertStr(b, "lead_name", true);
        assertStr(b, "email");
        assertStr(b, "phone");
        assertStr(b, "source");
        assertStr(b, "assigned_user_id");
        // detailed (optional)
        assertStr(b, "company_id");
        assertStr(b, "pipeline_id");
        assertStr(b, "stage_id");
        const created = await (0, leadsService_1.createLead)({
            tenant_id: tenantId,
            created_by: userId,
            lead_name: b.lead_name,
            email: b.email ?? null,
            phone: b.phone ?? null,
            source: b.source ?? null,
            assigned_user_id: b.assigned_user_id ?? null,
            company_id: b.company_id ?? null,
            pipeline_id: b.pipeline_id ?? null,
            stage_id: b.stage_id ?? null,
            value: typeof b.value === "number" ? b.value : (b.value ? Number(b.value) : null),
            tags: Array.isArray(b.tags) ? b.tags : null,
            notes: b.notes ?? null,
            address: b.address ?? null,
        });
        res.json({ ok: true, lead: created });
    }
    catch (err) {
        res.status(400).json({ ok: false, error: err?.message || "bad_request" });
    }
});
exports.default = router;
