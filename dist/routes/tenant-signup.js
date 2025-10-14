"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/tenant-signup.ts
const express_1 = require("express");
const crypto_1 = require("crypto");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("../db");
const provisionTenant_1 = require("../services/provisionTenant");
const router = (0, express_1.Router)();
/* ─────────────── Password policy ─────────────── */
const PASSWORD_POLICY = {
    minLength: 12,
    maxLength: 128,
    requireUpper: true,
    requireLower: true,
    requireDigit: true,
    requireSymbol: true,
    banned: new Set([
        "abc123", "123456", "123456789", "password", "qwerty", "letmein", "admin", "welcome",
    ]),
    symbolRegex: /[^A-Za-z0-9]/,
};
function checkPassword(pw) {
    const reasons = [];
    if (typeof pw !== "string" || !pw.trim()) {
        reasons.push("Password is required.");
        return { ok: false, reasons };
    }
    if (pw.length < PASSWORD_POLICY.minLength)
        reasons.push(`Minimum ${PASSWORD_POLICY.minLength} characters.`);
    if (pw.length > PASSWORD_POLICY.maxLength)
        reasons.push(`Maximum ${PASSWORD_POLICY.maxLength} characters.`);
    if (PASSWORD_POLICY.banned.has(pw.toLowerCase()))
        reasons.push("Too common / unsafe password.");
    if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(pw))
        reasons.push("Include at least one uppercase letter (A–Z).");
    if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(pw))
        reasons.push("Include at least one lowercase letter (a–z).");
    if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw))
        reasons.push("Include at least one number (0–9).");
    if (PASSWORD_POLICY.requireSymbol && !PASSWORD_POLICY.symbolRegex.test(pw))
        reasons.push("Include at least one symbol (e.g., !@#$%^&*).");
    if (/(.)\1\1/.test(pw))
        reasons.push("Avoid 3 or more repeated characters in a row.");
    if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwerty)/i.test(pw))
        reasons.push("Avoid simple sequences like '1234' or 'abcd'.");
    return { ok: reasons.length === 0, reasons };
}
/* ─────────────── Helpers ─────────────── */
function slugify(s) {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
async function listColumns(cx, table) {
    // schema-qualified & lower-cased
    const r = await cx.query(`SELECT LOWER(column_name) AS column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [table]);
    return new Set(r.rows.map((x) => String(x.column_name)));
}
function buildInsert(tableQualified, colsAvail, wanted) {
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
    if (cols.length === 0)
        throw new Error(`No matching columns to insert for table ${tableQualified}`);
    const text = `INSERT INTO ${tableQualified} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
    return { text, values: vals };
}
/* ─────────────── Main route ─────────────── */
router.post("/", async (req, res) => {
    const { org, name, email, password } = req.body || {};
    // Basic presence check
    if (typeof org !== "string" || !org.trim() ||
        typeof name !== "string" || !name.trim() ||
        typeof email !== "string" || !email.trim() ||
        typeof password !== "string" || !password.trim()) {
        return res.status(400).json({ ok: false, error: "Missing or invalid fields" });
    }
    // Password strength validation
    const pwCheck = checkPassword(password);
    if (!pwCheck.ok) {
        return res.status(400).json({
            ok: false,
            error: "weak_password",
            reasons: pwCheck.reasons,
            requirements: {
                minLength: PASSWORD_POLICY.minLength,
                requireUpper: PASSWORD_POLICY.requireUpper,
                requireLower: PASSWORD_POLICY.requireLower,
                requireDigit: PASSWORD_POLICY.requireDigit,
                requireSymbol: PASSWORD_POLICY.requireSymbol,
            },
        });
    }
    const emailLc = email.trim().toLowerCase();
    const tenantId = (0, crypto_1.randomUUID)();
    const companyId = (0, crypto_1.randomUUID)();
    const userId = (0, crypto_1.randomUUID)();
    const now = new Date();
    const baseSlug = slugify(org) || `org-${tenantId.slice(0, 8)}`;
    const cx = await db_1.pool.connect();
    let began = false;
    try {
        // Discover columns (public schema only)
        const tenantCols = await listColumns(cx, "tenant");
        const companyCols = await listColumns(cx, "company");
        const userCols = await listColumns(cx, "app_user");
        const mapCols = await listColumns(cx, "user_companies").catch(() => new Set());
        // Tenant display-name column can be either "name" or "org"
        const tenantNameCol = tenantCols.has("name") ? "name" : (tenantCols.has("org") ? "org" : null);
        if (!tenantCols.has("id") || !tenantNameCol) {
            return res.status(500).json({ ok: false, error: `Schema mismatch: tenant.id and tenant.name/org required` });
        }
        // Company required cols
        for (const c of ["id", "tenant_id", "name"]) {
            if (!companyCols.has(c)) {
                return res.status(500).json({ ok: false, error: `Schema mismatch: company.${c} missing` });
            }
        }
        // User required cols
        for (const c of ["id", "tenant_id", "name", "email"]) {
            if (!userCols.has(c)) {
                return res.status(500).json({ ok: false, error: `Schema mismatch: app_user.${c} missing` });
            }
        }
        // Password column choice
        const hasPasswordHash = userCols.has("password_hash");
        const hasPassword = userCols.has("password");
        if (!hasPasswordHash && !hasPassword) {
            return res.status(500).json({
                ok: false,
                error: "Schema mismatch: need app_user.password_hash or app_user.password",
            });
        }
        // Pre-check existing email to avoid 23505
        const existing = await cx.query(`SELECT id FROM public.app_user WHERE email = $1 LIMIT 1`, [emailLc]);
        if (existing.rowCount > 0) {
            return res.status(409).json({ ok: false, error: "email_exists", user_id: existing.rows[0].id });
        }
        const passwordHash = await bcryptjs_1.default.hash(password, 10);
        await cx.query("BEGIN");
        began = true;
        /* ─ Tenant ─ */
        const tenantWantedBase = {
            id: tenantId,
            is_active: true,
            created_at: now,
        };
        tenantWantedBase[tenantNameCol] = org.trim(); // "name" or "org"
        if (tenantCols.has("meta")) {
            tenantWantedBase["meta"] = {
                modules_enabled: ["crm", "hr", "accounts", "inventory", "projects", "reports"],
            };
        }
        if (tenantCols.has("slug")) {
            let slug = baseSlug;
            let inserted = false;
            for (let i = 0; i < 8 && !inserted; i++) {
                const withSlug = { ...tenantWantedBase, slug };
                const ins = buildInsert("public.tenant", tenantCols, withSlug);
                try {
                    await cx.query(ins.text, ins.values);
                    inserted = true;
                }
                catch (e) {
                    if (e?.code === "23505") {
                        slug = `${baseSlug}-${i + 2}`;
                        continue;
                    }
                    throw e;
                }
            }
            if (!inserted)
                throw new Error("Could not create unique tenant slug after retries");
        }
        else {
            const ins = buildInsert("public.tenant", tenantCols, tenantWantedBase);
            await cx.query(ins.text, ins.values);
        }
        /* ─ Company ─ */
        const companyWanted = {
            id: companyId,
            tenant_id: tenantId,
            name: org.trim(),
            is_active: true,
            created_at: now,
        };
        const compIns = buildInsert("public.company", companyCols, companyWanted);
        await cx.query(compIns.text, compIns.values);
        /* ─ User ─ */
        const userWanted = {
            id: userId,
            tenant_id: tenantId,
            name: name.trim(),
            email: emailLc,
            is_owner: true,
            is_active: true,
            created_at: now,
        };
        if (userCols.has("is_admin"))
            userWanted["is_admin"] = true;
        if (userCols.has("is_tenant_admin"))
            userWanted["is_tenant_admin"] = true;
        if (hasPasswordHash)
            userWanted["password_hash"] = passwordHash;
        else
            userWanted["password"] = passwordHash;
        const userIns = buildInsert("public.app_user", userCols, userWanted);
        await cx.query(userIns.text, userIns.values);
        /* ─ User ↔ Company mapping (optional) ─ */
        if (mapCols.size > 0) {
            const mapWanted = {
                tenant_id: tenantId,
                company_id: companyId,
                user_id: userId,
                is_default: true,
                created_at: now,
            };
            const mapIns = buildInsert("public.user_companies", mapCols, mapWanted);
            try {
                await cx.query(mapIns.text, mapIns.values);
            }
            catch (e) {
                if (e?.code !== "23505")
                    throw e; // ignore unique dup on map
            }
        }
        await cx.query("COMMIT");
        began = false;
        // RBAC provision (non-blocking)
        try {
            await (0, provisionTenant_1.provisionTenantRBAC)(db_1.pool, tenantId, userId);
        }
        catch (e) {
            console.error("[tenant-signup] RBAC provision error:", e);
        }
        return res.status(201).json({ ok: true, tenantId, companyId, userId });
    }
    catch (err) {
        if (began) {
            try {
                await cx.query("ROLLBACK");
            }
            catch { }
        }
        console.error("[tenant-signup] error:", {
            message: err?.message, code: err?.code, detail: err?.detail, constraint: err?.constraint, table: err?.table, column: err?.column
        });
        // Map common DB errors to clearer responses
        if (err?.code === "23505") {
            return res.status(409).json({ ok: false, error: "unique_violation", detail: err?.detail, constraint: err?.constraint });
        }
        if (err?.message?.includes("No matching columns to insert")) {
            return res.status(500).json({ ok: false, error: "schema_mismatch", hint: err?.message });
        }
        const payload = { ok: false, error: "Signup failed" };
        if (process.env.NODE_ENV !== "production") {
            if (err?.message)
                payload.hint = err.message;
            if (err?.code)
                payload.code = err.code;
            if (err?.detail)
                payload.detail = err.detail;
            if (err?.constraint)
                payload.constraint = err.constraint;
        }
        return res.status(500).json(payload);
    }
    finally {
        cx.release();
    }
});
exports.default = router;
