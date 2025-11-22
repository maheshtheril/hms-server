import { Router } from "express";
import { q } from "../../../db";

const router = Router();

/* STEP 1: Start onboarding */
router.post("/start", async (req, res) => {
  const { companyId } = req.body;

  await q(
    `UPDATE company_settings
     SET profile = COALESCE(profile, '{}'::jsonb) || '{"hms_onboarding": {"started": true}}'::jsonb
     WHERE company_id = $1`,
    [companyId]
  );

  return res.json({ ok: true });
});

/* STEP 2: Create departments */
router.post("/departments", async (req, res) => {
  const { tenantId, companyId, departments } = req.body;

  if (!Array.isArray(departments))
    return res.status(400).json({ error: "invalid_departments" });

  try {
    for (const d of departments) {
      await q(
        `INSERT INTO hms_department (tenant_id, company_id, name)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, companyId, d]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("departments", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* STEP 3: Staff */
router.post("/staff", async (req, res) => {
  const { tenantId, companyId, staff } = req.body;

  if (!Array.isArray(staff)) return res.status(400).json({ error: "invalid_staff" });

  // optional; depends on your schema
  try {
    for (const s of staff) {
      await q(
        `INSERT INTO hms_staff (tenant_id, company_id, name, role)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, companyId, s.name, s.role]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

/* STEP 4: Billing mode */
router.post("/billing", async (req, res) => {
  const { companyId, mode } = req.body;

  if (!["cash", "insurance", "mixed"].includes(mode))
    return res.status(400).json({ error: "invalid_mode" });

  await q(
    `UPDATE company_settings
     SET profile = profile || $1::jsonb
     WHERE company_id = $2`,
    [JSON.stringify({ hms_billing_mode: mode }), companyId]
  );

  return res.json({ ok: true });
});

/* STEP 5: Complete onboarding */
router.post("/complete", async (req, res) => {
  const { companyId } = req.body;

  await q(
    `UPDATE company_settings
     SET profile = profile || '{"hms_onboarding": {"completed": true}}'::jsonb
     WHERE company_id = $1`,
    [companyId]
  );

  return res.json({ ok: true });
});

export default router;
