"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeOutbox = writeOutbox;
exports.fetchAndClaim = fetchAndClaim;
exports.markProcessed = markProcessed;
exports.markFailed = markFailed;
// server/src/services/outbox.ts
const db_1 = __importDefault(require("../db"));
const { q } = db_1.default; // only for non-transactional reads if needed
/**
 * Write an outbox row inside an existing transaction.
 * Pass the transaction client (client.query(...)).
 */
async function writeOutbox(client, { tenantId, aggregateType, aggregateId, eventType, payload }) {
    const sql = `
    INSERT INTO public.hms_outbox (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, attempts, created_at)
    VALUES (gen_random_uuid(), $1,$2,$3,$4,$5, 0, now())
    RETURNING id
  `;
    const res = await client.query(sql, [tenantId, aggregateType, aggregateId || null, eventType, JSON.stringify(payload)]);
    return res.rows[0].id;
}
/**
 * CLAIM a batch of outbox rows for processing.
 * This updates locked_at atomically and returns rows.
 * Use UTC now () in Postgres.
 *
 * `limit` = how many rows to claim in this batch.
 */
async function fetchAndClaim(client, limit = 10) {
    // Use UPDATE ... RETURNING to atomically claim rows that are not processed and not locked (or stale lock)
    // stale lock: locked_at older than 5 minutes (worker crashed)
    const claimSql = `
    WITH candidates AS (
      SELECT id FROM public.hms_outbox
      WHERE processed_at IS NULL
        AND (
          locked_at IS NULL OR locked_at < now() - interval '5 minutes'
        )
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.hms_outbox o
    SET locked_at = now(), attempts = attempts + 1
    FROM candidates c
    WHERE o.id = c.id
    RETURNING o.id, o.tenant_id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.attempts, o.locked_at, o.processed_at, o.created_at;
  `;
    const r = await client.query(claimSql, [limit]);
    return r.rows;
}
/**
 * Mark outbox row as processed (success)
 */
async function markProcessed(client, outboxId) {
    await client.query(`UPDATE public.hms_outbox SET processed_at = now(), last_error = NULL WHERE id = $1`, [outboxId]);
}
/**
 * Mark outbox row as failed (stores error). Worker may retry based on attempts.
 * Optionally you can set a maximum attempts threshold and move to poison queue.
 */
async function markFailed(client, outboxId, errMsg) {
    await client.query(`UPDATE public.hms_outbox SET last_error = $1 WHERE id = $2`, [errMsg, outboxId]);
}
