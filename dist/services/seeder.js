"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueSeedJob = enqueueSeedJob;
async function enqueueSeedJob(job) {
    // TODO: integrate BullMQ/queue later.
    console.log("[seeder] enqueueSeedJob →", job);
    return { queued: true };
}
