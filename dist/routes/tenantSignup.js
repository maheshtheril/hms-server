"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/tenantSignup.ts
const express_1 = require("express");
const crypto_1 = require("crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("../db");
const provisionTenant_1 = require("../services/provisionTenant"); // ⬅️ stays
const router = (0, express_1.Router)();
function slugify(s) {
    return s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
}
/** Return a set of column names for a table */
async function listColumns(table) {
    const r = await db_1.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
    return new Set(r.rows.map((x) => String(x.column_name)));
}
/** Build an INSERT that only uses existing columns */
function buildInsert(table, colsAvail, wanted) {
    const cols = [];
    const vals = [];
    const placeholders = [];
    let i = 1;
    for (const [col, value] of Object.entries(wanted)) {
        if (colsAvail.has(col)) {
            cols.push(col);
            vals.push(value);
            placeholders.push(`$${i++}`);
        }
    }
    if (cols.length === 0) {
        throw new Error(`No matching columns to insert for table ${table}`);
    }
    const text = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${colsAvail.has("id") ? "id" : cols[0]}`;
    return { text, values: vals };
}
router.post("/", async (req, res) => {
    const { org, name, email, password } = req.body || {};
    if (typeof org !== "string" || !org.trim() ||
        typeof name !== "string" || !name.trim() ||
        typeof email !== "string" || !email.trim() ||
        typeof password !== "string" || !password.trim()) {
        return res.status(400).json({ ok: false, error: "Missing or invalid fields" });
    }
    const emailLc = email.trim().toLowerCase();
    const tenantId = (0, crypto_1.randomUUID)();
    const companyId = (0, crypto_1.randomUUID)();
    const userId = (0, crypto_1.randomUUID)();
    const now = new Date();
    const baseSlug = slugify(org) || `org-${tenantId.slice(0, 8)}`;
    try {
        // Discover schema
        const tenantCols = await listColumns("tenant");
        const companyCols = await listColumns("company");
        const userCols = await listColumns("app_user");
        const mapCols = await listColumns("user_companies").catch(() => new Set());
        // Required columns sanity
        for (const [t, cols, reqs] of [
            ["tenant", tenantCols, ["id", "name"]], // slug handled below if present & NOT NULL
            ["company", companyCols, ["id", "tenant_id", "name"]],
            ["app_user", userCols, ["id", "tenant_id", "name", "email"]],
        ]) {
            for (const c of reqs) {
                if (!cols.has(c)) {
                    return res.status(500).json({ ok: false, error: `Schema mismatch: ${t}.${c} missing` });
                }
            }
        }
        // Determine password column
        const hasPasswordHash = userCols.has("password_hash");
        const hasPassword = userCols.has("password");
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        if (!hasPasswordHash && !hasPassword) {
            return res.status(500).json({
                ok: false,
                error: "Schema mismatch: need app_user.password_hash or app_user.password",
            });
        }
        await db_1.pool.query("BEGIN");
        // 1) TENANT — include slug if present, and seed meta.modules_enabled if meta exists
        const tenantWantedBase = {
            id: tenantId,
            name: org.trim(),
            is_active: true,
            created_at: now,
        };
        // Prepare meta if column exists
        if (tenantCols.has("meta")) {
            tenantWantedBase["meta"] = {
                // You can trim this list if you want partial enablement by default
                modules_enabled: ["crm", "hr", "accounts", "inventory", "projects", "reports"],
            };
        }
        if (tenantCols.has("slug")) {
            let slug = baseSlug;
            let success = false;
            for (let i = 0; i < 8 && !success; i++) {
                const tenantWanted = { ...tenantWantedBase, slug };
                const ins = buildInsert("tenant", tenantCols, tenantWanted);
                try {
                    await db_1.pool.query(ins.text, ins.values);
                    success = true;
                }
                catch (e) {
                    // 23505 = unique violation (likely slug unique)
                    if (e?.code === "23505") {
                        slug = `${baseSlug}-${(i + 2)}`; // try new slug
                        continue;
                    }
                    throw e; // other errors bubble up
                }
            }
            if (!success) {
                throw new Error("Could not create unique tenant slug after retries");
            }
        }
        else {
            // No slug column in table → just insert without slug
            const tenantWanted = { ...tenantWantedBase };
            const ins = buildInsert("tenant", tenantCols, tenantWanted);
            await db_1.pool.query(ins.text, ins.values);
        }
        // 2) COMPANY (default)
        const companyWanted = {
            id: companyId,
            tenant_id: tenantId,
            name: org.trim(),
            is_active: true,
            created_at: now,
        };
        const compIns = buildInsert("company", companyCols, companyWanted);
        await db_1.pool.query(compIns.text, compIns.values);
        // 3) APP USER (owner, make admin if columns exist)
        const userWanted = {
            id: userId,
            tenant_id: tenantId,
            name: name.trim(),
            email: emailLc,
            is_owner: true,
            is_active: true,
            created_at: now,
        };
        // Grant admin flags for the first user when those columns exist
        if (userCols.has("is_admin"))
            userWanted["is_admin"] = true;
        if (userCols.has("is_tenant_admin"))
            userWanted["is_tenant_admin"] = true;
        if (hasPasswordHash)
            userWanted["password_hash"] = passwordHash;
        else
            userWanted["password"] = passwordHash;
        const userIns = buildInsert("app_user", userCols, userWanted);
        await db_1.pool.query(userIns.text, userIns.values);
        // 4) USER ↔ COMPANY mapping (optional)
        if (mapCols.size > 0) {
            const mapWanted = {
                tenant_id: tenantId,
                company_id: companyId,
                user_id: userId,
                is_default: true,
                created_at: now,
            };
            const mapIns = buildInsert("user_companies", mapCols, mapWanted);
            try {
                await db_1.pool.query(mapIns.text, mapIns.values);
            }
            catch (e) {
                if (e?.code !== "23505")
                    throw e; // ignore unique violation if any
            }
        }
        await db_1.pool.query("COMMIT");
        // 5) RBAC provisioning (best-effort; won’t block signup)
        try {
            await (0, provisionTenant_1.provisionTenantRBAC)(db_1.pool, tenantId, userId);
        }
        catch (e) {
            console.error("[tenant-signup] RBAC provision error:", e);
            // do not throw — signup already committed
        }
        return res.json({ ok: true, tenantId, companyId, userId });
    }
    catch (err) {
        try {
            await db_1.pool.query("ROLLBACK");
        }
        catch { }
        console.error("[tenant-signup] error:", err);
        if (process.env.NODE_ENV !== "production") {
            const payload = { ok: false, error: err?.message || "Signup failed" };
            if (err?.code)
                payload.code = err.code;
            if (err?.detail)
                payload.detail = err.detail;
            if (err?.table)
                payload.table = err.table;
            if (err?.column)
                payload.column = err.column;
            return res.status(500).json(payload);
        }
        return res.status(500).json({ ok: false, error: "Signup failed" });
    }
});
exports.default = router;
