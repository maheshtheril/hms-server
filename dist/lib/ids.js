"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePatientNumber = generatePatientNumber;
// server/src/lib/ids.ts
const db_1 = require("../db");
/**
 * Simple tenant-scoped patient number generator.
 * You can replace with sequence table or other scheme as needed.
 */
async function generatePatientNumber(tenantId) {
    // try to use a sequence table per tenant (recommended). Fallback: random short id.
    try {
        // Example: increment counter in a dedicated table (create table tenant_counters if needed)
        const { rows } = await (0, db_1.q)(`INSERT INTO tenant_counters (tenant_id, last_value)
         VALUES ($1, 1)
    ON CONFLICT (tenant_id)
       DO UPDATE SET last_value = tenant_counters.last_value + 1
    RETURNING last_value`, [tenantId]);
        const n = rows[0]?.last_value ?? Math.floor(Math.random() * 90000) + 10000;
        return `P-${tenantId.slice(0, 8)}-${n}`;
    }
    catch (err) {
        // fallback
        return `P-${Math.random().toString(36).slice(2, 9)}`;
    }
}
