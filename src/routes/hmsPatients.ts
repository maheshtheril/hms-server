// server/src/routes/hmsPatients.ts
import express from "express";
import db from "../db";
import { requireAuth } from "../middleware/requireAuth";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

/**
 * NOTE:
 * - This file expects your ambient types to declare Express.Request.user with
 *   tenant_id?: string | null and company_id?: string | null.
 *
 *   e.g. server/src/types/express.d.ts
 *
 *     declare global {
 *       namespace Express {
 *         interface User {
 *           id: string;
 *           tenant_id?: string | null;
 *           company_id?: string | null;
 *           roles?: string[];
 *         }
 *         interface Request {
 *           user?: User;
 *         }
 *       }
 *     }
 *
 * - router is mounted at: app.use("/api/hms/patients", hmsPatientsRouter);
 */

router.use(requireAuth);

/* ---------------------------- GET /api/hms/patients ---------------------------- */
router.get("/", async (req, res, next) => {
  try {
    // defensive typing: prefer req.user to be present because requireAuth runs earlier
    const user = req.user as Express.User | undefined;
    if (!user || !user.tenant_id) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenant_id;
    const userCompanyId = user.company_id ?? null;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    // Build WHERE & params in the correct order
    const whereClauses: string[] = ["tenant_id = $1"];
    const params: any[] = [tenantId];
    let paramIndex = 2;

    // If user's session has company_id, scope by it (multi-company isolation)
    // If you want tenant-admins to view all companies, expand this logic accordingly.
    if (userCompanyId) {
      whereClauses.push(`company_id = $${paramIndex++}`);
      params.push(userCompanyId);
    }

    if (q) {
      whereClauses.push(
        `(
           COALESCE(patient_number, '') ILIKE $${paramIndex}
           OR COALESCE(first_name, '') ILIKE $${paramIndex + 1}
           OR COALESCE(last_name, '') ILIKE $${paramIndex + 2}
         )`
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      paramIndex += 3;
    }

    // push limit/offset as last params
    params.push(limit, offset);
    const limitParamIdx = paramIndex++;
    const offsetParamIdx = paramIndex++;

    const sql = `
      SELECT id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender,
             identifiers, contact, metadata, created_by, created_at, updated_at
      FROM public.hms_patient
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx};
    `;

    const result = await db.query(sql, params);
    // Optionally return total count for pagination — separate count query for accuracy
    res.json({ rows: result.rows });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- GET /api/hms/patients/:id ---------------------------- */
router.get("/:id", async (req, res, next) => {
  try {
    const user = req.user as Express.User | undefined;
    if (!user || !user.tenant_id) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenant_id;
    const { id } = req.params;

    const sql = `SELECT * FROM public.hms_patient WHERE id = $1 AND tenant_id = $2 LIMIT 1;`;
    const r = await db.query(sql, [id, tenantId]);

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- POST /api/hms/patients ---------------------------- */
router.post("/", async (req, res, next) => {
  try {
    const user = req.user as Express.User | undefined;
    if (!user || !user.tenant_id) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenant_id;
    // prefer company from session (ensures created patient is scoped to session's company)
    const companyId = user.company_id ?? null;
    const userId = user.id ?? null;

    const {
      first_name,
      last_name,
      dob,
      gender,
      patient_number,
      identifiers = {},
      contact = {},
      metadata = {},
    } = req.body ?? {};

    if (!first_name || typeof first_name !== "string") {
      return res.status(400).json({ error: "first_name_required" });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    const insertSQL = `
      INSERT INTO public.hms_patient (
        id, tenant_id, company_id, patient_number, first_name, last_name, dob, gender,
        identifiers, contact, metadata, created_by, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
      )
      RETURNING *;
    `;

    const params = [
      id,
      tenantId,
      companyId,
      patient_number ?? null,
      first_name,
      last_name ?? null,
      dob ?? null,
      gender ?? null,
      JSON.stringify(identifiers),
      JSON.stringify(contact),
      JSON.stringify(metadata),
      userId,
      now,
      now,
    ];

    const result = await db.query(insertSQL, params);
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    // Postgres unique violation code for constraint / unique index
    if (err?.code === "23505") return res.status(409).json({ error: "duplicate_patient_number" });
    next(err);
  }
});

/* ---------------------------- PUT /api/hms/patients/:id ---------------------------- */
router.put("/:id", async (req, res, next) => {
  try {
    const user = req.user as Express.User | undefined;
    if (!user || !user.tenant_id) return res.status(401).json({ error: "unauthorized" });
    const tenantId = user.tenant_id;
    const { id } = req.params;

    const updatable = [
      "first_name",
      "last_name",
      "dob",
      "gender",
      "patient_number",
      "identifiers",
      "contact",
      "metadata",
      // Note: do NOT include company_id unless you explicitly want to allow company re-assignment here.
    ];

    const setParts: string[] = [];
    const params: any[] = [];
    let idx = 1;

    for (const k of updatable) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        setParts.push(`${k} = $${idx}`);
        const v = ["identifiers", "contact", "metadata"].includes(k)
          ? JSON.stringify(req.body[k] ?? {})
          : req.body[k];
        params.push(v);
        idx++;
      }
    }

    if (!setParts.length) return res.status(400).json({ error: "no_fields_to_update" });

    // add updated_at
    setParts.push(`updated_at = NOW()`);

    // WHERE clause params
    params.push(id, tenantId);
    const idParam = idx++;
    const tenantParam = idx++;

    const sql = `
      UPDATE public.hms_patient
      SET ${setParts.join(", ")}
      WHERE id = $${idParam} AND tenant_id = $${tenantParam}
      RETURNING *;
    `;

    const r = await db.query(sql, params);
    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json(r.rows[0]);
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "duplicate_patient_number" });
    next(err);
  }
});

/* ---------------------------- DELETE /api/hms/patients/:id ---------------------------- */
router.delete("/:id", async (req, res, next) => {
  try {
    const user = req.user as Express.User | undefined;
    if (!user || !user.tenant_id) return res.status(401).json({ error: "unauthorized" });

    const tenantId = user.tenant_id;
    const { id } = req.params;

    const sql = `DELETE FROM public.hms_patient WHERE id = $1 AND tenant_id = $2 RETURNING id;`;
    const r = await db.query(sql, [id, tenantId]);

    if (!r.rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
