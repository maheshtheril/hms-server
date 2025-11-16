// server/src/routes/global/currencies.ts
import express from "express";
import { pool, query } from "../../db";
import { body, validationResult } from "express-validator";

const router = express.Router();

/**
 * GET /api/global/currencies
 * Optional query params:
 *   ?active=true|false
 *   ?q=search
 */
router.get("/", async (req, res, next) => {
  try {
    const { active, q } = req.query;
    const conditions: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (active === "true" || active === "false") {
      conditions.push(`is_active = $${idx++}`);
      values.push(active === "true");
    }

    if (typeof q === "string" && q.trim()) {
      const t = `%${q.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(code) LIKE $${idx} OR LOWER(name) LIKE $${idx})`);
      values.push(t);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT id, code, name, symbol, precision, is_active, created_at, updated_at
                 FROM currencies ${where}
                 ORDER BY name ASC`;
    const { rows } = await query(sql, values);
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/global/currencies/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const sql = `SELECT id, code, name, symbol, precision, is_active, created_at, updated_at
                 FROM currencies WHERE id = $1 LIMIT 1`;
    const { rows } = await query(sql, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/global/currencies
 */
router.post(
  "/",
  [
    body("code").isString().isLength({ min: 3, max: 3 }).trim().toUpperCase(),
    body("name").isString().isLength({ min: 1 }).trim(),
    body("symbol").optional().isString().trim(),
    body("precision").optional().isInt({ min: 0, max: 6 }).toInt(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const { code, name, symbol = null, precision = 2 } = req.body;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const insertSql = `
          INSERT INTO currencies (code, name, symbol, precision)
          VALUES ($1, $2, $3, $4)
          RETURNING id, code, name, symbol, precision, is_active, created_at, updated_at
        `;
        const { rows } = await client.query(insertSql, [code, name, symbol, precision]);
        await client.query("COMMIT");
        res.status(201).json({ ok: true, data: rows[0] });
      } catch (err: any) {
        await client.query("ROLLBACK");
        // unique violation on code
        if (err?.constraint === "currencies_code_key" || /unique/i.test(err?.message || "")) {
          return res.status(409).json({ ok: false, error: "currency_code_exists" });
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
 * PUT /api/global/currencies/:id
 * Partial update
 */
router.put(
  "/:id",
  [
    body("code").optional().isString().isLength({ min: 3, max: 3 }).trim().toUpperCase(),
    body("name").optional().isString().isLength({ min: 1 }).trim(),
    body("symbol").optional().isString().trim(),
    body("precision").optional().isInt({ min: 0, max: 6 }).toInt(),
    body("is_active").optional().isBoolean().toBoolean(),
  ],
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

      const allowed = ["code", "name", "symbol", "precision", "is_active"];
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
      const sql = `UPDATE currencies SET ${sets.join(", ")}, updated_at = now() WHERE id = $${idx} RETURNING id, code, name, symbol, precision, is_active, created_at, updated_at`;
      const { rows } = await query(sql, vals as any[]);
      if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true, data: rows[0] });
    } catch (err: any) {
      if (err?.constraint === "currencies_code_key" || /unique/i.test(err?.message || "")) {
        return res.status(409).json({ ok: false, error: "currency_code_exists" });
      }
      next(err);
    }
  }
);

/**
 * DELETE /api/global/currencies/:id
 * Soft-delete (is_active = false)
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE currencies SET is_active = false, updated_at = now() WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
