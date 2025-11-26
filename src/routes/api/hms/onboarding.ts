// server/src/routes/onboarding/hms.ts
import { Router, Request, Response } from "express";
import { q, pool } from "../../../db";
import { body, validationResult } from "express-validator";

const router = Router();

/* helper to return validation errors */
function handleValidation(req: Request, res: Response) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: "invalid_request", details: errors.array() });
    return true;
  }
  return false;
}

/* STEP 1: Start onboarding */
router.post(
  "/start",
  [body("companyId").optional().isString().isLength({ min: 1 })],
  async (req: Request, res: Response) => {
    if (handleValidation(req, res)) return;
    // Prefer companyId from session if available:
    const companyId = (req as any).body.companyId ?? (req as any).user?.companyId;
    if (!companyId) return res.status(400).json({ error: "missing_companyId" });

    try {
      await q(
        `UPDATE company_settings
         SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
         WHERE company_id = $2`,
        [JSON.stringify({ hms_onboarding: { started: true } }), companyId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("onboarding.start", err);
      return res.status(500).json({ error: "server_error" });
    }
  }
);

/* STEP 2: Create departments (batch insert using explicit transaction) */
router.post(
  "/departments",
  [
    body("tenantId").optional().isString(),
    body("companyId").optional().isString(),
    body("departments").isArray({ min: 1 }),
    body("departments.*").isString().isLength({ min: 1, max: 200 }),
  ],
  async (req: Request, res: Response) => {
    if (handleValidation(req, res)) return;
    const tenantId = (req as any).body.tenantId ?? (req as any).user?.tenantId;
    const companyId = (req as any).body.companyId ?? (req as any).user?.companyId;
    const { departments } = (req as any).body;
    if (!tenantId || !companyId) return res.status(400).json({ error: "missing_tenant_or_company" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // build parameterized VALUES: ($1,$2,$3),($4,$5,$6)...
      const vals: any[] = [];
      const parts: string[] = [];
      departments.forEach((name: string, idx: number) => {
        const base = idx * 3;
        parts.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
        vals.push(tenantId, companyId, name.trim());
      });

      const sql = `
        INSERT INTO hms_department (tenant_id, company_id, name)
        VALUES ${parts.join(", ")}
        ON CONFLICT (tenant_id, company_id, name) DO NOTHING
        RETURNING id, name
      `;
      const r = await client.query(sql, vals);

      await client.query("COMMIT");

      return res.json({ ok: true, created: r.rows });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      console.error("onboarding.departments", err);
      if (!res.headersSent) return res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }
  }
);

/* STEP 3: Staff (transactional, batch insert using explicit transaction) */
router.post(
  "/staff",
  [
    body("tenantId").optional().isString(),
    body("companyId").optional().isString(),
    body("staff").isArray({ min: 1 }),
    body("staff.*.name").isString().isLength({ min: 1, max: 200 }),
    body("staff.*.role").optional().isString().isLength({ max: 200 }),
  ],
  async (req: Request, res: Response) => {
    if (handleValidation(req, res)) return;
    const tenantId = (req as any).body.tenantId ?? (req as any).user?.tenantId;
    const companyId = (req as any).body.companyId ?? (req as any).user?.companyId;
    const { staff } = (req as any).body;
    if (!tenantId || !companyId) return res.status(400).json({ error: "missing_tenant_or_company" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const vals: any[] = [];
      const parts: string[] = [];
      staff.forEach((s: any, idx: number) => {
        const base = idx * 4;
        parts.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        vals.push(tenantId, companyId, s.name.trim(), s.role ?? null);
      });

      const sql = `
        INSERT INTO hms_staff (tenant_id, company_id, name, role)
        VALUES ${parts.join(", ")}
        RETURNING id, name, role
      `;
      const r = await client.query(sql, vals);

      await client.query("COMMIT");

      return res.json({ ok: true, created: r.rows });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      console.error("onboarding.staff", err);
      if (!res.headersSent) return res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }
  }
);

/* STEP 4: Billing mode */
router.post(
  "/billing",
  [body("companyId").optional().isString(), body("mode").isIn(["cash", "insurance", "mixed"])],
  async (req: Request, res: Response) => {
    if (handleValidation(req, res)) return;
    const companyId = (req as any).body.companyId ?? (req as any).user?.companyId;
    const { mode } = (req as any).body;
    if (!companyId) return res.status(400).json({ error: "missing_companyId" });

    try {
      await q(
        `UPDATE company_settings
         SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
         WHERE company_id = $2`,
        [JSON.stringify({ hms_billing_mode: mode }), companyId]
      );
      return res.json({ ok: true, mode });
    } catch (err) {
      console.error("onboarding.billing", err);
      return res.status(500).json({ error: "server_error" });
    }
  }
);

/* STEP 5: Complete onboarding */
router.post(
  "/complete",
  [body("companyId").optional().isString()],
  async (req: Request, res: Response) => {
    if (handleValidation(req, res)) return;
    const companyId = (req as any).body.companyId ?? (req as any).user?.companyId;
    if (!companyId) return res.status(400).json({ error: "missing_companyId" });

    try {
      await q(
        `UPDATE company_settings
         SET profile = COALESCE(profile, '{}'::jsonb) || $1::jsonb
         WHERE company_id = $2`,
        [JSON.stringify({ hms_onboarding: { completed: true } }), companyId]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error("onboarding.complete", err);
      return res.status(500).json({ error: "server_error" });
    }
  }
);

export default router;
