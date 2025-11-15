// server/src/routes/taxes/tax-types.ts
import { Router, Request, Response, NextFunction } from "express";
import { q } from "../../db";
// NOTE: import the tenant middleware (RequestHandler) — NOT a transaction helper.
import { withTenant } from "../../middleware/tenant";

const router = Router();

// GET all tax types for a tenant
router.get("/", withTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenant;
    if (!tenantId) return res.status(400).json({ error: "missing_tenant" });

    const rows = await q(
      `SELECT * FROM tax_types WHERE tenant_id = $1 ORDER BY name ASC`,
      [tenantId]
    );

    return res.json(rows.rows);
  } catch (err) {
    return next(err);
  }
});

// CREATE tax type
router.post("/", withTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenant;
    if (!tenantId) return res.status(400).json({ error: "missing_tenant" });

    const { name, code, description } = req.body;
    const row = await q(
      `INSERT INTO tax_types (tenant_id, name, code, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, name, code, description]
    );

    return res.json(row.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// UPDATE
router.put("/:id", withTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenant;
    if (!tenantId) return res.status(400).json({ error: "missing_tenant" });

    const { id } = req.params;
    const { name, code, description, active } = req.body;

    const row = await q(
      `UPDATE tax_types
       SET name=$1, code=$2, description=$3, active=$4, updated_at = now()
       WHERE id=$5 AND tenant_id=$6
       RETURNING *`,
      [name, code, description, active, id, tenantId]
    );

    return res.json(row.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// DELETE
router.delete("/:id", withTenant, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = (req as any).tenant;
    if (!tenantId) return res.status(400).json({ error: "missing_tenant" });

    const { id } = req.params;

    await q(
      `DELETE FROM tax_types WHERE id=$1 AND tenant_id=$2`,
      [id, tenantId]
    );

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
