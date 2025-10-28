// server/src/routes/hmsClinicians.ts
import { Router, Request, Response } from "express";
import { q } from "../db"; // DB helper (pg.query)
import requireSession from "../middleware/requireSession";

const router = Router();

/* -------------------------------------------------------------------------- */
/*                                VALIDATION                                 */
/* -------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/*                         SESSION COMPANY ID HELPER                          */
/* -------------------------------------------------------------------------- */
/**
 * Safely derive company_id from session, supporting both
 * `company_id` and older/alternate `active_company_id`.
 * Returns string | null
 */
function getCompanyIdFromSession(req: Request): string | null {
  // req.session is not typed by Express by default — cast to `any` for safe lookup
  const s: any = (req as any).session;
  if (!s) return null;
  return s.company_id ?? s.active_company_id ?? null;
}

/* -------------------------------------------------------------------------- */
/*                             ROUTE DEFINITIONS                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/hms/clinicians
 * - returns clinicians scoped to req.session.tenant_id and company_id
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenant_id: string | undefined = (req as any).session?.tenant_id;
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
    res.json({ data: clinicians.rows });
  } catch (err) {
    console.error("Error fetching clinicians:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /api/hms/clinicians/:id
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id: string | undefined = (req as any).session?.tenant_id;
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const clinician = await q(
      `SELECT * FROM hms_clinicians WHERE id=$1 AND tenant_id=$2 AND company_id=$3`,
      [id, tenant_id, company_id]
    );

    if (!clinician.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ data: clinician.rows[0] });
  } catch (err) {
    console.error("Error fetching clinician:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * POST /api/hms/clinicians
 */
router.post("/", requireSession, async (req: Request, res: Response) => {
  try {
    const tenant_id: string | undefined = (req as any).session?.tenant_id;
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const {
      first_name,
      last_name,
      email,
      phone,
      role,
      specialization,
      license_no,
      experience_years,
      department_id,
    } = req.body;

    // Basic validation
    if (!first_name || !last_name) {
      return res.status(400).json({ error: "first_name and last_name are required" });
    }

    const inserted = await q(
      `
      INSERT INTO hms_clinicians (
        tenant_id, company_id, department_id,
        first_name, last_name, email, phone,
        role, specialization, license_no, experience_years
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `,
      [
        tenant_id,
        company_id,
        department_id || null,
        first_name,
        last_name,
        email || null,
        phone || null,
        role || null,
        specialization || null,
        license_no || null,
        experience_years ?? null,
      ]
    );

    res.status(201).json({ data: inserted.rows[0] });
  } catch (err: any) {
    console.error("Clinician create failed:", err);
    // Unique violation (email)
    if (err.code === "23505") return res.status(400).json({ error: "Email already exists" });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * PUT /api/hms/clinicians/:id
 */
router.put("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id: string | undefined = (req as any).session?.tenant_id;
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const {
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
    } = req.body;

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
        department_id || null,
        is_active ?? true,
        id,
        tenant_id,
        company_id,
      ]
    );

    if (!updated.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    console.error("Clinician update failed:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * DELETE /api/hms/clinicians/:id
 */
router.delete("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid ID" });

    const tenant_id: string | undefined = (req as any).session?.tenant_id;
    const company_id = getCompanyIdFromSession(req);

    if (!tenant_id || !company_id) {
      return res.status(400).json({ error: "Missing tenant or company in session" });
    }

    const deleted = await q(
      `DELETE FROM hms_clinicians WHERE id=$1 AND tenant_id=$2 AND company_id=$3 RETURNING id`,
      [id, tenant_id, company_id]
    );

    if (!deleted.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Clinician delete failed:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
