// server/src/routes/api/onboarding/retail.ts
import { pool } from "../../../db";
import { getSession } from "../../../lib/session";
import { v4 as uuidv4 } from "uuid";

/**
 * Retail onboarding API
 *
 * POST /api/onboarding/retail
 * Body:
 * {
 *  storeLocations: [{ name, address }],
 *  registers: [{ name, currency }],
 *  defaultCategories: [ "Apparel", "Electronics" ],
 *  taxRegion: { countryId: "IN", defaultTaxPercent: 18 },
 *  pricingPolicy: "retail" | "wholesale" | "mixed",
 *  paymentMethods: ["cash","card","upi","wallet"],
 *  seedOpeningInventory: boolean,
 *  runNow?: boolean  // optional: run synchronously (debug/test only)
 * }
 *
 * Behavior:
 *  - Auth required via session cookie.
 *  - Validates minimal payload.
 *  - If runNow === true -> calls the provisioner directly (sync).
 *  - Otherwise inserts a row into provisioning_queue for background worker.
 */

export async function retailOnboardingHandler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const sid = req.cookies?.erp_session;
    const session = sid ? await getSession(sid) : null;

    if (!session || !session.user_id || !session.company_id || !session.tenant_id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const tenantId = session.tenant_id;
    const companyId = session.company_id;
    const userId = session.user_id;

    const body = req.body || (await parseBody(req));
    const {
      storeLocations,
      registers,
      defaultCategories,
      taxRegion,
      pricingPolicy,
      paymentMethods,
      seedOpeningInventory,
      runNow,
    } = body || {};

    // minimal validation
    if (!Array.isArray(storeLocations) || storeLocations.length === 0) {
      return res.status(400).json({ error: "missing_store_locations" });
    }
    if (!Array.isArray(registers) || registers.length === 0) {
      return res.status(400).json({ error: "missing_registers" });
    }
    if (!taxRegion || typeof taxRegion.countryId !== "string") {
      return res.status(400).json({ error: "missing_tax_region" });
    }

    // payload we will provision with
    const payload = {
      storeLocations,
      registers,
      defaultCategories: Array.isArray(defaultCategories) ? defaultCategories : [],
      taxRegion,
      pricingPolicy: pricingPolicy || "retail",
      paymentMethods: Array.isArray(paymentMethods) ? paymentMethods : [],
      seedOpeningInventory: Boolean(seedOpeningInventory),
    };

    // run now (synchronous) - useful for dev/testing only
    if (runNow === true) {
      // dynamically import provisioner and execute (same canonical module used by worker)
      try {
        const mod = await import("../../../industries/retail/provisioning");
        if (!mod || typeof mod.provision !== "function") {
          return res.status(500).json({ error: "provisioner_missing" });
        }
        await mod.provision(tenantId, companyId, userId, payload);
        return res.status(200).json({ ok: true, result: "completed" });
      } catch (err) {
        console.error("retail onboarding runNow error:", err);
        return res.status(500).json({ error: "provision_failed", message: err.message });
      }
    }

    // enqueue background job into provisioning_queue
    const client = await pool.connect();
    try {
      const jobId = uuidv4();
      await client.query(
        `INSERT INTO provisioning_queue
          (id, tenant_id, company_id, user_id, industry, job_type, payload, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',now())`,
        [
          jobId,
          tenantId,
          companyId,
          userId,
          "retail", // industry
          "retail_onboarding", // job_type
          JSON.stringify(payload),
        ]
      );

      return res.status(202).json({ ok: true, result: "queued", jobId });
    } catch (err) {
      console.error("enqueue retail onboarding failed:", err);
      return res.status(500).json({ error: "enqueue_failed" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("retail onboarding server error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}

/* raw body parser for environments that don't auto-parse */
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
