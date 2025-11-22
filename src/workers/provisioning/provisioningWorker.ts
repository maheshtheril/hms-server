// server/src/workers/provisioning/provisioningWorker.ts
import { getNextProvisioningJob, markJobProcessing, markJobDone, markJobFailed } from "./queueUtils";
import { getProvisionerForIndustry } from "../../industries/industryRegistry";

async function startProvisioningWorker() {
  console.log("[Provisioning Worker] Started");

  while (true) {
    let job: any = null;

    try {
      job = await getNextProvisioningJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      await markJobProcessing(job.id);

      const { industry, tenant_id, company_id, user_id, payload } = job;

      // *** NOTE: getProvisionerForIndustry is async; await it ***
      const provisioner = await getProvisionerForIndustry(industry);

      if (!provisioner) {
        await markJobFailed(job.id, `No provisioner found for industry=${industry}`);
        continue;
      }

      // provisioner should be a function: async function(tenantId, companyId, userId, payload)
      if (typeof provisioner !== "function") {
        await markJobFailed(job.id, `Invalid provisioner type for industry=${industry}`);
        continue;
      }

      // payload stored as JSON string in queue — parse safely
      let parsedPayload = {};
      try {
        parsedPayload = payload ? JSON.parse(payload) : {};
      } catch (err) {
        console.warn("[Provisioning Worker] payload JSON parse failed, using empty object:", err);
        parsedPayload = {};
      }

      // Execute the provisioner
      await provisioner(tenant_id, company_id, user_id, parsedPayload);

      await markJobDone(job.id);
      // loop continues
    } catch (err: any) {
      console.error("[Provisioning Worker Error]", err);

      // Ensure we mark the job failed if possible
      try {
        if (job?.id) {
          await markJobFailed(job.id, err?.message || String(err));
        }
      } catch (markErr) {
        console.error("[Provisioning Worker] markJobFailed error:", markErr);
      }

      // back off a bit before next loop iteration
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startProvisioningWorker();
