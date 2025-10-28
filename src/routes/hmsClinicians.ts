// server/src/routes/hmsClinicians.ts
import { Router, Request, Response } from "express";
import { q } from "../db"; // DB helper (pg.query)
import requireSession from "../middleware/requireSession";

const router = Router();

/* --------------------------- helpers & validation ------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getCompanyIdFromSession(req: Request): string | null {
  const s: any = (req as any).session;
  if (!s) return null;
  return s.company_id ?? s.active_company_id ?? null;
}

function getTenantIdFromSession(req: Request): string | null {
  const s: any = (req as any).session;
  if (!s) return null;
  return s.tenant_id ?? null;
}

function parseNullableInt(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

function parseNullableString(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function parseBooleanish(v: any, fallback = true): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return fallback;
}

/* --------------------------------- routes -------------------------------- */

router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const clinicians = await q(
      `
      SELECT c.*, d.name AS department_name
      FROM hms_clinicians c
      LEFT JOIN hms_departments d ON c.department_id = d.id
      WHERE c.tenant_id = $1 AND c.company_id = $2
      ORDER BY c.created_at DESC
      `,
      [tenant_id, company_id]
    );

    return res.json({ data: clinicians.rows });
  } catch (err) {
    console.error("Error fetching clinicians:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const clinician = await q(
      `SELECT c.*, d.name AS department_name FROM hms_clinicians c LEFT JOIN hms_departments d ON c.department_id = d.id WHERE c.id=$1 AND c.tenant_id=$2 AND c.company_id=$3`,
      [id, tenant_id, company_id]
    );

    if (!clinician.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ data: clinician.rows[0] });
  } catch (err) {
    console.error("Error fetching clinician:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const first_name = parseNullableString(req.body.first_name);
    const last_name = parseNullableString(req.body.last_name);
    const email = parseNullableString(req.body.email);
    const phone = parseNullableString(req.body.phone);
    const role = parseNullableString(req.body.role);
    const specialization = parseNullableString(req.body.specialization);
    const license_no = parseNullableString(req.body.license_no);
    const experience_years = parseNullableInt(req.body.experience_years);
    const department_id = parseNullableString(req.body.department_id);
    const is_active = parseBooleanish(req.body.is_active, true);

    if (!first_name || !last_name) {
      return res.status(400).json({ error: "first_name and last_name are required" });
    }

    if (department_id && !UUID_RE.test(department_id)) {
      return res.status(400).json({ error: "Invalid department_id" });
    }

    const inserted = await q(
      `
      INSERT INTO hms_clinicians (
        tenant_id, company_id, department_id,
        first_name, last_name, email, phone,
        role, specialization, license_no, experience_years, is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
      `,
      [
        tenant_id,
        company_id,
        department_id,
        first_name,
        last_name,
        email,
        phone,
        role,
        specialization,
        license_no,
        experience_years,
        is_active,
      ]
    );

    return res.status(201).json({ data: inserted.rows[0] });
  } catch (err: any) {
    console.error("Clinician create failed:", err);
    // Postgres unique violation
    if (err && (err.code === "23505" || (err.detail && String(err.detail).includes("already exists")))) {
      return res.status(409).json({ error: "Email already exists" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.put("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);
    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const first_name = parseNullableString(req.body.first_name);
    const last_name = parseNullableString(req.body.last_name);
    const email = parseNullableString(req.body.email);
    const phone = parseNullableString(req.body.phone);
    const role = parseNullableString(req.body.role);
    const specialization = parseNullableString(req.body.specialization);
    const license_no = parseNullableString(req.body.license_no);
    const experience_years = parseNullableInt(req.body.experience_years);
    const department_id = parseNullableString(req.body.department_id);
    const is_active = parseBooleanish(req.body.is_active, true);

    if (!first_name || !last_name) {
      return res.status(400).json({ error: "first_name and last_name are required" });
    }

    if (department_id && !UUID_RE.test(department_id)) {
      return res.status(400).json({ error: "Invalid department_id" });
    }

    const updated = await q(
      `
      UPDATE hms_clinicians
      SET first_name=$1, last_name=$2, email=$3, phone=$4,
          role=$5, specialization=$6, license_no=$7,
          experience_years=$8, department_id=$9, is_active=$10, updated_at=now()
      WHERE id=$11 AND tenant_id=$12 AND company_id=$13
      RETURNING *
      `,
      [
        first_name,
        last_name,
        email,
        phone,
        role,
        specialization,
        license_no,
        experience_years,
        department_id,
        is_active,
        id,
        tenant_id,
        company_id,
      ]
    );

    if (!updated.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ data: updated.rows[0] });
  } catch (err: any) {
    console.error("Clinician update failed:", err);
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Email already exists" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

/* PATCH — allow partial updates (useful for toggles like is_active) */
router.patch("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);
    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    // Build dynamic set list
    const allowed = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "role",
      "specialization",
      "license_no",
      "experience_years",
      "department_id",
      "is_active",
    ];

    const setClauses: string[] = [];
    const values: any[] = [];

    let idx = 1;
    for (const key of allowed) {
      if (req.body.hasOwnProperty(key)) {
        let val: any = req.body[key];
        if (key === "experience_years") val = parseNullableInt(val);
        if (key === "department_id") {
          if (val !== null && val !== undefined && val !== "" && !UUID_RE.test(String(val))) {
            return res.status(400).json({ error: "Invalid department_id" });
          }
        }
        if (key === "is_active") val = parseBooleanish(val, true);
        setClauses.push(`${key}=$${idx}`);
        values.push(val);
        idx++;
      }
    }

    if (!setClauses.length) return res.status(400).json({ error: "No valid fields to update" });

    // add id, tenant, company params
    values.push(id, tenant_id, company_id);

    const sql = `
      UPDATE hms_clinicians
      SET ${setClauses.join(", ")}, updated_at=now()
      WHERE id=$${idx} AND tenant_id=$${idx + 1} AND company_id=$${idx + 2}
      RETURNING *
    `;

    const updated = await q(sql, values);

    if (!updated.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ data: updated.rows[0] });
  } catch (err: any) {
    console.error("Clinician patch failed:", err);
    if (err && err.code === "23505") {
      return res.status(409).json({ error: "Email already exists" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id = getTenantIdFromSession(req);
    const company_id = getCompanyIdFromSession(req);
    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const deleted = await q(`DELETE FROM hms_clinicians WHERE id=$1 AND tenant_id=$2 AND company_id=$3 RETURNING id`, [
      id,
      tenant_id,
      company_id,
    ]);

    if (!deleted.rows.length) return res.status(404).json({ error: "Not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Clinician delete failed:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
