// server/src/routes/api/onboarding/manufacturing.ts
import { getSession } from "../../../lib/session";
import { enqueueProvisionJob } from "../../../lib/provisioningQueue";

/**
 * POST /api/onboarding/manufacturing
 * Body: { manufacturingType, enableWorkCenters, enableBOMTemplates, defaultRoutingCount }
 *
 * Enqueues a manufacturing provisioning job.
 */
export async function manufacturingOnboardingHandler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const body = req.body || (await parseBody(req));
    const { manufacturingType = "discrete", enableWorkCenters = true, enableBOMTemplates = true, defaultRoutingCount = 2 } = body || {};

    const sid = req.cookies?.erp_session;
    const session = sid ? await getSession(sid) : null;
    if (!session || !session.user_id || !session.company_id) {
      return res.status(401).json({ error: "not_authenticated" });
    }

    const jobPayload = {
      manufacturingType,
      enableWorkCenters: Boolean(enableWorkCenters),
      enableBOMTemplates: Boolean(enableBOMTemplates),
      defaultRoutingCount: Number(defaultRoutingCount) || 2,
    };

    try {
      await enqueueProvisionJob({
        industry: "manufacturing",
        tenantId: session.tenant_id,
        companyId: session.company_id,
        userId: session.user_id,
        payload: jobPayload,
      });
    } catch (err) {
      console.error("enqueueProvisionJob failed (manufacturing):", err);
      return res.status(202).json({ ok: true, provisioning: "enqueue_failed" });
    }

    return res.status(202).json({ ok: true, provisioning: "queued" });
  } catch (err) {
    console.error("manufacturing onboarding handler error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}

/* raw body parser fallback */
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
