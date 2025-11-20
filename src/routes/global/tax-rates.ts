// server/src/routes/global/tax-rates.ts
import express from "express";
import { pool } from "../../db";
import { body, validationResult } from "express-validator";

const router = express.Router();

// Helper to set tenant on the current connection (like admin/companies)
const TENANT_UUID_SQL = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

async function setTenantOn(client: any, req: any) {
  const tid = String(req.session?.tenant_id || req.headers["x-tenant-id"] || "").trim();
  if (!tid) throw Object.assign(new Error("tenant_id_required"), { status: 400 });
  await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tid]);
}

/**
 * GET /api/global/tax-rates
 * Optional: ?tax_type_id=... & ?active=true|false
 */
router.get("/", async (req, res, next) => {
  const client = await pool.connect();
  try {
    // ensure tenant context for this connection if required by DB (throw if missing)
    await setTenantOn(client, req);

    const { tax_type_id, active } = req.query;
    const where: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    if (typeof tax_type_id === "string" && tax_type_id.trim()) {
      where.push(`tr.tax_type_id = $${idx++}`);
      vals.push(tax_type_id.trim());
    }
    if (active === "true" || active === "false") {
      where.push(`tr.is_active = $${idx++}`);
      vals.push(active === "true");
    }

    const sql = `
      SELECT tr.id, tr.name, tr.rate, tr.is_active, tr.created_at, tr.updated_at,
             tt.id as tax_type_id, tt.name as tax_type_name
      FROM tax_rates tr
      JOIN tax_types tt ON tt.id = tr.tax_type_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY tt.name ASC, tr.rate DESC
    `;
    const { rows } = await client.query(sql, vals);
    res.json({ ok: true, data: rows });
  } catch (err: any) {
    if (err?.status === 400 && err.message === "tenant_id_required") {
      return res.status(400).json({ ok: false, error: "tenant_id_required" });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * GET /api/global/tax-rates/:id
 */
router.get("/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await setTenantOn(client, req);

    const sql = `
      SELECT tr.id, tr.name, tr.rate, tr.is_active, tr.created_at, tr.updated_at,
             tt.id as tax_type_id, tt.name as tax_type_name
      FROM tax_rates tr
      JOIN tax_types tt ON tt.id = tr.tax_type_id
      WHERE tr.id = $1 LIMIT 1
    `;
    const { rows } = await client.query(sql, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rows[0] });
  } catch (err: any) {
    if (err?.status === 400 && err.message === "tenant_id_required") {
      return res.status(400).json({ ok: false, error: "tenant_id_required" });
    }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * POST /api/global/tax-rates
 * body: { tax_type_id, name, rate }
 */
router.post(
  "/",
  [
    body("tax_type_id").isUUID(),
    body("name").isString().isLength({ min: 1 }).trim(),
    body("rate").isFloat({ min: 0 }).toFloat(),
  ],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await setTenantOn(client, req);

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const { tax_type_id, name, rate } = req.body;
      try {
        await client.query("BEGIN");
        // ensure tax type exists and active (tenant-scoped)
        const { rows: tt } = await client.query("SELECT id FROM tax_types WHERE id = $1 AND is_active = true LIMIT 1", [tax_type_id]);
        if (!tt.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ ok: false, error: "invalid_tax_type" });
        }

        const insertSql = `
          INSERT INTO tax_rates (tax_type_id, name, rate)
          VALUES ($1, $2, $3)
          RETURNING id, tax_type_id, name, rate, is_active, created_at, updated_at
        `;
        const { rows } = await client.query(insertSql, [tax_type_id, name, rate]);
        await client.query("COMMIT");
        res.status(201).json({ ok: true, data: rows[0] });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } catch (err: any) {
      if (err?.status === 400 && err.message === "tenant_id_required") {
        return res.status(400).json({ ok: false, error: "tenant_id_required" });
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * PUT /api/global/tax-rates/:id
 */
router.put(
  "/:id",
  [
    body("tax_type_id").optional().isUUID(),
    body("name").optional().isString().trim(),
    body("rate").optional().isFloat({ min: 0 }).toFloat(),
    body("is_active").optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await setTenantOn(client, req);

      const id = req.params.id;
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      if (req.body.tax_type_id) {
        const { rows: tt } = await client.query("SELECT id FROM tax_types WHERE id = $1 AND is_active = true LIMIT 1", [req.body.tax_type_id]);
        if (!tt.length) return res.status(400).json({ ok: false, error: "invalid_tax_type" });
      }

      const allowed = ["tax_type_id", "name", "rate", "is_active"];
      const sets: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          sets.push(`${k} = $${idx++}`);
          vals.push(req.body[k]);
        }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: "no_fields" });

      vals.push(id);
      const sql = `UPDATE tax_rates SET ${sets.join(", ")}, updated_at = now() WHERE id = $${idx} RETURNING id, tax_type_id, name, rate, is_active, created_at, updated_at`;
      const { rows } = await client.query(sql, vals);
      if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true, data: rows[0] });
    } catch (err: any) {
      if (err?.status === 400 && err.message === "tenant_id_required") {
        return res.status(400).json({ ok: false, error: "tenant_id_required" });
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * DELETE /api/global/tax-rates/:id
 * Soft-delete
 */
router.delete("/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await setTenantOn(client, req);

    const { rows } = await client.query(`UPDATE tax_rates SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.status === 400 && err.message === "tenant_id_required") {
      return res.status(400).json({ ok: false, error: "tenant_id_required" });
    }
    next(err);
  } finally {
    client.release();
  }
});

export default router;
