// server/src/routes/admin/permissions.ts
import { Router } from "express";
import { pool } from "../../db";

const router = Router();

/* ───────── Utils ───────── */
function sanitizeCode(code: string) {
  return String(code || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9\.\-_]/g, "");
}

/* ───────── LIST (with legacy merge) ─────────
   Returns canonical permissions from `permission` table,
   plus any legacy strings discovered in role.permissions text[].
   Supports ?q=, ?limit=, ?offset=
*/
router.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(parseInt(String(req.query.limit || "500"), 10) || 500, 1000);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    const params: any[] = [];
    let where = "";
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE code ILIKE $1
               OR name ILIKE $1
               OR coalesce(description,'') ILIKE $1
               OR coalesce(category,'') ILIKE $1`;
    }

    // Canonical catalog
    const sql = `
      SELECT code, name, description, category, is_deprecated
      FROM permission
      ${where}
      ORDER BY category NULLS LAST, code ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const cat = await pool.query(sql, params);

    // Count only canonical
    const catCount = await pool.query(
      `SELECT count(*)::int AS cnt FROM permission ${where}`, params
    );

    // Legacy discovery from role.permissions[] (for visibility during migration)
    const legacy = await pool.query(`
      WITH all_codes AS (
        SELECT DISTINCT unnest(permissions)::text AS code
        FROM public.role
        WHERE permissions IS NOT NULL AND array_length(permissions,1) > 0
      )
      SELECT code FROM all_codes
      WHERE NOT EXISTS (SELECT 1 FROM permission p WHERE p.code = all_codes.code)
      ORDER BY code ASC
    `);

    const legacyRows = legacy.rows.map(r => ({
      code: r.code as string,
      name: toHuman(r.code as string),
      description: null,
      category: r.code?.split(".")[0] ?? null,
      is_deprecated: null
    }));

    res.json({
      items: [...cat.rows, ...legacyRows],
      total: catCount.rows[0].cnt,
      limit,
      offset
    });
  } catch (e) { next(e); }
});

function toHuman(code: string) {
  return code.replace(/[_\.]/g, " ").replace(/\b\w/g, s => s.toUpperCase());
}

/* ───────── CREATE ───────── */
router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};
    const code = sanitizeCode(body.code);
    const name = String(body.name || "").trim();
    const description = body.description == null ? null : String(body.description);
    const category = body.category == null ? null : String(body.category);
    const is_deprecated = !!body.is_deprecated;

    if (!code) return res.status(400).json({ error: "code is required" });
    if (!name) return res.status(400).json({ error: "name is required" });

    await pool.query(
      `INSERT INTO permission (code, name, description, category, is_deprecated)
       VALUES ($1,$2,$3,$4,$5)`,
      [code, name, description, category, is_deprecated]
    );

    const r = await pool.query(
      `SELECT code, name, description, category, is_deprecated
       FROM permission WHERE code=$1`,
      [code]
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) {
    if (e?.code === "23505") {
      return res.status(409).json({ error: "Permission code already exists" });
    }
    next(e);
  }
});

/* ───────── UPDATE ─────────
   - Code is the PK → we don't change it here.
*/
router.put("/:code", async (req, res, next) => {
  try {
    const code = sanitizeCode(req.params.code);
    const body = req.body || {};
    const name = body.name == null ? undefined : String(body.name).trim();
    const description = body.description === undefined ? undefined : (body.description == null ? null : String(body.description));
    const category = body.category === undefined ? undefined : (body.category == null ? null : String(body.category));
    const is_deprecated = body.is_deprecated === undefined ? undefined : !!body.is_deprecated;

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (name !== undefined) { sets.push(`name=$${i++}`); vals.push(name); }
    if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }
    if (category !== undefined) { sets.push(`category=$${i++}`); vals.push(category); }
    if (is_deprecated !== undefined) { sets.push(`is_deprecated=$${i++}`); vals.push(is_deprecated); }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    vals.push(code);
    const r = await pool.query(
      `UPDATE permission SET ${sets.join(", ")}, created_at = created_at
       WHERE code=$${i}
       RETURNING code, name, description, category, is_deprecated`,
      vals
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

/* ───────── DELETE ─────────
   - Block deletion if permission is assigned to any role (role_permission).
*/
router.delete("/:code", async (req, res, next) => {
  try {
    const code = sanitizeCode(req.params.code);

    const used = await pool.query(
      `SELECT 1 FROM role_permission WHERE permission_code=$1 LIMIT 1`,
      [code]
    );
    if ((used?.rowCount ?? 0) > 0) {

      return res.status(409).json({ error: "Permission is assigned to at least one role; unassign before deleting." });
    }

    const r = await pool.query(`DELETE FROM permission WHERE code=$1`, [code]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
