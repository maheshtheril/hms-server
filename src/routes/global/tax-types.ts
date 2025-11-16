// server/src/routes/global/tax-types.ts
import express from "express";
import { pool, query } from "../../db";
import { body, validationResult } from "express-validator";

const router = express.Router();

/**
 * GET /api/global/tax-types
 */
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM tax_types
       ORDER BY name ASC`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/global/tax-types/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, description, is_active, created_at, updated_at
       FROM tax_types WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/global/tax-types
 */
router.post(
  "/",
  [body("name").isString().isLength({ min: 1 }).trim(), body("description").optional().isString().trim()],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const { name, description = null } = req.body;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO tax_types (name, description)
           VALUES ($1, $2)
           RETURNING id, name, description, is_active, created_at, updated_at`,
          [name, description]
        );
        await client.query("COMMIT");
        res.status(201).json({ ok: true, data: rows[0] });
      } catch (err: any) {
        await client.query("ROLLBACK");
        if (err?.constraint === "tax_types_name_key" || /unique/i.test(err?.message || "")) {
          return res.status(409).json({ ok: false, error: "tax_type_exists" });
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/global/tax-types/:id
 */
router.put(
  "/:id",
  [
    body("name").optional().isString().isLength({ min: 1 }).trim(),
    body("description").optional().isString().trim(),
    body("is_active").optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const allowed = ["name", "description", "is_active"];
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
      const sql = `UPDATE tax_types SET ${sets.join(", ")}, updated_at = now() WHERE id = $${idx} RETURNING id, name, description, is_active, created_at, updated_at`;
      const { rows } = await query(sql, vals);
      if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true, data: rows[0] });
    } catch (err: any) {
      if (err?.constraint === "tax_types_name_key" || /unique/i.test(err?.message || "")) {
        return res.status(409).json({ ok: false, error: "tax_type_exists" });
      }
      next(err);
    }
  }
);

/**
 * DELETE /api/global/tax-types/:id
 * Soft-delete; prevents disabling if child tax_rates exist
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const { rows: rr } = await query(`SELECT 1 FROM tax_rates WHERE tax_type_id = $1 LIMIT 1`, [id]);
    if (rr.length) return res.status(400).json({ ok: false, error: "has_child_tax_rates" });

    const { rows } = await query(`UPDATE tax_types SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
