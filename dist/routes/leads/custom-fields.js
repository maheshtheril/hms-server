"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/leads/custom-fields.ts
const express_1 = require("express");
const db_1 = require("../../db");
const requireSession_1 = __importDefault(require("../../middleware/requireSession"));
const router = (0, express_1.Router)();
router.use(requireSession_1.default);
// quick UUID guard
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RX.test(v);
// Resolve tenant_id safely out of session
function getTenantId(req) {
    const t = String(req.session?.tenant_id || "").trim();
    if (!t || !isUuid(t)) {
        throw Object.assign(new Error("tenant_id missing or invalid"), { status: 401 });
    }
    return t;
}
/**
 * Shape we’ll return for GET:
 * [
 *   {
 *     definition_id, key, label, field_type, options, required, visible, sort_order,
 *     value_text, value_number, value_boolean, value_json
 *   }
 * ]
 *
 * Assumes tables:
 *  - custom_field_definitions (id, tenant_id, module, key, label, field_type, options, required, visible, sort_order)
 *  - custom_field_value (tenant_id, lead_id, definition_id, value_text, value_number, value_boolean, value_json)
 * Ensure a unique index exists on (tenant_id, lead_id, definition_id).
 */
// GET /api/leads/:leadId/custom-fields
router.get("/:leadId/custom-fields", async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const { leadId } = req.params;
        if (!isUuid(leadId)) {
            return res.status(400).json({ error: "Invalid leadId" });
        }
        const q = `
      SELECT
        d.id AS definition_id,
        d.key,
        d.label,
        d.field_type,
        d.options,
        d.required,
        d.visible,
        d.sort_order,
        v.value_text,
        v.value_number,
        v.value_boolean,
        v.value_json
      FROM custom_field_definitions d
      LEFT JOIN custom_field_value v
        ON v.tenant_id = d.tenant_id
       AND v.definition_id = d.id
       AND v.lead_id = $2::uuid
      WHERE d.tenant_id = $1::uuid
        AND d.module = 'lead'
      ORDER BY COALESCE(d.sort_order, 9999), d.label;
    `;
        const { rows } = await db_1.pool.query(q, [tenantId, leadId]);
        res.json(rows);
    }
    catch (err) {
        const status = err.status || 500;
        res.status(status).json({ error: err.message || "Failed to fetch custom fields" });
    }
});
/**
 * PUT /api/leads/:leadId/custom-fields/:definitionId
 * Body can contain exactly one of:
 *  { value_text } | { value_number } | { value_boolean } | { value_json }
 */
router.put("/:leadId/custom-fields/:definitionId", async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        const userId = String(req.session?.user_id || "").trim();
        const { leadId, definitionId } = req.params;
        if (!isUuid(leadId) || !isUuid(definitionId)) {
            return res.status(400).json({ error: "Invalid leadId or definitionId" });
        }
        const { value_text, value_number, value_boolean, value_json } = req.body || {};
        // build dynamic upsert
        const cols = [];
        const vals = [tenantId, leadId, definitionId, userId || null];
        if (value_text !== undefined) {
            cols.push("value_text");
            vals.push(String(value_text));
        }
        else if (value_number !== undefined) {
            cols.push("value_number");
            vals.push(Number(value_number));
        }
        else if (value_boolean !== undefined) {
            cols.push("value_boolean");
            vals.push(Boolean(value_boolean));
        }
        else if (value_json !== undefined) {
            cols.push("value_json");
            vals.push(value_json);
        }
        else {
            return res.status(400).json({ error: "No value_* provided" });
        }
        // name parameters
        // vals: [1:tenant_id, 2:lead_id, 3:definition_id, 4:created_by, 5+: value_*]
        const valueParamIndex = 5;
        const insertCols = ["tenant_id", "lead_id", "definition_id", "created_by", ...cols];
        const insertValsPlaceholders = insertCols.map((_, i) => `$${i + 1}`);
        const updateAssignments = cols.map((c, i) => `${c} = EXCLUDED.${c}`);
        const sql = `
      INSERT INTO custom_field_value (${insertCols.join(",")})
      VALUES (${insertValsPlaceholders.join(",")})
      ON CONFLICT (tenant_id, lead_id, definition_id)
      DO UPDATE SET ${updateAssignments.join(", ")};
    `;
        await db_1.pool.query(sql, vals);
        res.json({ ok: true });
    }
    catch (err) {
        // If ON CONFLICT fails, you likely don't have the unique index → see note below.
        res.status(500).json({ error: err.message || "Failed to upsert custom field value" });
    }
});
exports.default = router;
