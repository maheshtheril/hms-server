// src/services/seeder.ts
type SeedJob = {
  tenantId: string;
  adminUserId?: string;
};

export async function enqueueSeedJob(job: SeedJob) {
  // TODO: integrate BullMQ/queue later.
  console.log("[seeder] enqueueSeedJob →", job);
  return { queued: true };
}
