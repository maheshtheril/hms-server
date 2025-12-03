// server/src/routes/api/onboarding/hms.ts
import { Router, Request, Response } from "express";
import { pool } from "../../../db";
import { getSession } from "../../../lib/session";

const router = Router();

/* ---------------------------------------------------------
   UTIL — get session from middleware or cookie fallback
--------------------------------------------------------- */
async function resolveSession(req: any) {
  if (req.authSession) return req.authSession;
  if (req.session) return req.session;

  const cookies = req.cookies ?? {};
  const keys = ["sid", "session_id", "SESSION_ID", "erp_session"];

  for (const k of keys) {
    if (!cookies[k]) continue;
    try {
      const s = await getSession(cookies[k]);
      if (s) return s;
    } catch (e) {}
  }

  return null;
}

/* ---------------------------------------------------------
   NEW: SINGLE-ENDPOINT HMS ONBOARDING
   Matches frontend: POST /api/onboarding/hms
   Body: { departments: string[], billingMode: "cash"|"insurance"|"mixed" }
--------------------------------------------------------- */
router.post("/", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const { departments, billingMode } = (req.body || {}) as {
      departments?: string[];
      billingMode?: string;
    };

    // sanitize departments
    const depsArray = Array.isArray(departments)
      ? departments
          .map((d) => String(d || "").trim())
          .filter((d) => d.length > 0)
      : [];

    if (!depsArray.length) {
      return res.status(400).json({ error: "invalid_departments" });
    }

    // sanitize billing mode (default to "cash")
    const allowedModes = ["cash", "insurance", "mixed"] as const;
    const mode = allowedModes.includes(billingMode as any) ? billingMode : "cash";

    const tenantId = session.tenant_id;
    const companyId = session.company_id;

    if (!companyId) {
      return res.status(400).json({ error: "no_company_in_session" });
    }

    // ✅ FIX: cast text[] → jsonb properly using to_jsonb($1::text[])
    await pool.query(
      `
      UPDATE company_settings
      SET
        hms_sub_industry = 'hospital',
        hms_departments   = to_jsonb($1::text[]),
        hms_billing_mode  = $2,
        updated_at        = now()
      WHERE company_id = $3
    `,
      [depsArray, mode, companyId]
    );

    return res.json({
      ok: true,
      tenantId,
      companyId,
      departments: depsArray,
      billingMode: mode,
      redirect: "/tenant/dashboard",
    });
  } catch (err) {
    console.error("[HMS onboarding /] error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   STEP 1 — START ONBOARDING
   (legacy multi-step; can be kept or deleted if unused)
--------------------------------------------------------- */
router.post("/start", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });

    const companyId = session.company_id;

    await pool.query(
      `
      UPDATE company_settings
      SET profile = COALESCE(profile, '{}'::jsonb) 
                    || '{"hms_onboarding":{"started":true}}'::jsonb,
          updated_at = now()
      WHERE company_id = $1
    `,
      [companyId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("HMS onboarding START error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   STEP 2 — DEPARTMENTS
--------------------------------------------------------- */
router.post("/departments", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });

    const { departments } = req.body;
    if (!Array.isArray(departments))
      return res.status(400).json({ error: "invalid_departments" });

    const tenantId = session.tenant_id;
    const companyId = session.company_id;
    const userId = session.user_id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const d of departments) {
        const name = String(d || "").trim();
        if (!name) continue;

        await client.query(
          `
          INSERT INTO hms_departments
            (id, tenant_id, company_id, name, is_active, created_by)
          VALUES (gen_random_uuid(), $1, $2, $3, true, $4)
          ON CONFLICT (company_id, name) DO NOTHING
        `,
          [tenantId, companyId, name, userId]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("HMS onboarding DEPARTMENTS error:", err);
      return res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("departments outer error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   STEP 3 — STAFF (optional)
--------------------------------------------------------- */
router.post("/staff", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });

    const { staff } = req.body;
    if (!Array.isArray(staff)) return res.status(400).json({ error: "invalid_staff" });

    const tenantId = session.tenant_id;
    const companyId = session.company_id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const s of staff) {
        const name = String(s?.name || "").trim();
        const role = s?.role || null;
        if (!name) continue;

        await client.query(
          `
          INSERT INTO hms_staff (id, tenant_id, company_id, name, role)
          VALUES (gen_random_uuid(), $1, $2, $3, $4)
        `,
          [tenantId, companyId, name, role]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("HMS onboarding STAFF error:", err);
      return res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("staff outer error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   STEP 4 — BILLING MODE
--------------------------------------------------------- */
router.post("/billing", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });

    const { mode } = req.body;
    if (!["cash", "insurance", "mixed"].includes(mode))
      return res.status(400).json({ error: "invalid_billing_mode" });

    const companyId = session.company_id;

    await pool.query(
      `
      UPDATE company_settings
      SET profile = COALESCE(profile, '{}'::jsonb)
                    || jsonb_build_object('hms_billing_mode', $1),
          updated_at = now()
      WHERE company_id = $2
    `,
      [mode, companyId]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("HMS onboarding BILLING error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   STEP 5 — COMPLETE ONBOARDING (FINAL)
--------------------------------------------------------- */
router.post("/complete", async (req: Request, res: Response) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.status(401).json({ error: "not_authenticated" });

    const tenantId = session.tenant_id;
    const companyId = session.company_id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      /* --------------------------------------------
         Create default Ward + Bed (idempotent)
      -------------------------------------------- */
      await client.query(
        `
        INSERT INTO hms_ward (id, tenant_id, company_id, name)
        VALUES (gen_random_uuid(), $1, $2, 'General Ward')
        ON CONFLICT (company_id, name) DO NOTHING
      `,
        [tenantId, companyId]
      );

      await client.query(
        `
        INSERT INTO hms_bed (id, tenant_id, company_id, ward_id, bed_no, status)
        SELECT gen_random_uuid(), $1, $2, w.id, '1', 'available'
        FROM hms_ward w
        WHERE w.company_id = $2 AND w.name = 'General Ward'
        LIMIT 1
      `,
        [tenantId, companyId]
      );

      /* --------------------------------------------
         Insert default Product Categories
      -------------------------------------------- */
      const categories = ["Medicines", "Consumables"];
      for (const c of categories) {
        await client.query(
          `
          INSERT INTO hms_product_category (id, tenant_id, company_id, name)
          VALUES (gen_random_uuid(), $1, $2, $3)
          ON CONFLICT DO NOTHING
        `,
          [tenantId, companyId, c]
        );
      }

      /* --------------------------------------------
         Insert default Lab Groups
      -------------------------------------------- */
      const labGroups = ["Blood Tests", "Urine Tests", "Imaging Reports"];
      for (const g of labGroups) {
        await client.query(
          `
          INSERT INTO hms_lab_test_group (id, tenant_id, company_id, name)
          VALUES (gen_random_uuid(), $1, $2, $3)
          ON CONFLICT DO NOTHING
        `,
          [tenantId, companyId, g]
        );
      }

      /* --------------------------------------------
         Mark onboarding as completed
      -------------------------------------------- */
      await client.query(
        `
        UPDATE company_settings
        SET profile = COALESCE(profile, '{}'::jsonb)
                      || '{"hms_onboarding":{"completed":true}}'::jsonb,
            updated_at = now()
        WHERE company_id = $1
      `,
        [companyId]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("HMS onboarding COMPLETE error:", err);
      return res.status(500).json({ error: "server_error" });
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      redirect: "/tenant/dashboard",
    });
  } catch (err) {
    console.error("complete outer error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ---------------------------------------------------------
   EXPORT ROUTER
--------------------------------------------------------- */
export default router;
