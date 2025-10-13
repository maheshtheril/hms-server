"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLead = createLead;
const db_1 = require("../db");
async function createLead(input) {
    const { tenant_id, created_by, lead_name, email, phone, source, assigned_user_id, company_id, pipeline_id, stage_id, value, tags, notes, address } = input;
    const { rows } = await (0, db_1.query)(`INSERT INTO leads (
       tenant_id, created_by, lead_name, email, phone, source, assigned_user_id,
       company_id, pipeline_id, stage_id, value, tags, notes,
       address_line1, address_line2, city, state, country, pincode
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING lead_id, lead_name, stage_id`, [tenant_id, created_by, lead_name, email ?? null, phone ?? null, source ?? null, assigned_user_id ?? null,
        company_id ?? null, pipeline_id ?? null, stage_id ?? null, value ?? null, tags ?? null, notes ?? null,
        address?.line1 ?? null, address?.line2 ?? null, address?.city ?? null, address?.state ?? null, address?.country ?? null, address?.pincode ?? null]);
    return rows[0];
}
