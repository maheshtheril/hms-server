"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/routes/admin/companies.ts
const express_1 = require("express");
const db_1 = require("../../db");
const requireSession_1 = __importDefault(require("../../middleware/requireSession"));
const router = (0, express_1.Router)();
router.use(requireSession_1.default);
const TENANT_UUID_SQL = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;
async function setTenantOn(conn, req) {
    const tid = String(req.session?.tenant_id || req.headers["x-tenant-id"] || "").trim();
    if (!tid)
        throw Object.assign(new Error("tenant_id_required"), { status: 400 });
    await conn.query(`select set_config('app.tenant_id', $1, false)`, [tid]);
}
router.get("/", async (req, res, next) => {
    const cx = await db_1.pool.connect();
    try {
        await setTenantOn(cx, req);
        const { rows } = await cx.query(`select id, name from public.company where tenant_id = ${TENANT_UUID_SQL} order by name asc`);
        res.json({ items: rows });
    }
    catch (e) {
        if (e?.status === 400)
            return res.status(400).json({ message: e.message });
        next(e);
    }
    finally {
        cx.release();
    }
});
exports.default = router;
