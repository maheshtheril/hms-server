"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = idempotency;
exports.saveIdempotencyResponse = saveIdempotencyResponse;
const db_1 = require("../db");
/**
 * Expect header: Idempotency-Key
 * Usage: use on POST / create endpoints. It will:
 *  - if key exists and processed -> return stored response
 *  - otherwise persist the key and let request proceed. The route handler MUST call
 *    res.locals.idempotency = { keyRowId } and the helper `saveIdempotencyResponse` below
 *    after successful commit to store the response.
 */
async function idempotency(req, res, next) {
    const key = (req.header('Idempotency-Key') || '').trim();
    if (!key)
        return next(); // no idempotency requested
    if (!req.session || !req.session.tenantId) {
        return res.status(401).json({ error: 'unauthenticated' });
    }
    try {
        // Check if already processed (tenant-scoped)
        const existing = await (0, db_1.q)(`SELECT response_status, response_body, processed_at FROM public.hms_idempotency_keys WHERE tenant_id = $1 AND key_text = $2`, [req.session.tenantId, key]);
        if (existing.rowCount > 0) {
            const row = existing.rows[0];
            if (row.processed_at) {
                res.status(row.response_status || 200).json(row.response_body || {});
                return;
            }
            // key exists but not processed => client may be retrying while first request is in-flight.
            // We allow request to proceed, but ensure uniqueness by returning conflict if another inserts same key.
            // For safety, return 202 Accepted to indicate request accepted and being processed:
            return res.status(202).json({ status: 'processing' });
        }
        // Insert a "pending" key record
        await (0, db_1.q)(`INSERT INTO public.hms_idempotency_keys (tenant_id, key_text, created_by, request_method, request_path, request_body) VALUES ($1,$2,$3,$4,$5,$6)`, [req.session.tenantId, key, req.session.userId || null, req.method, req.path, req.body ? JSON.stringify(req.body) : null]);
        // Pass key in locals so handlers can persist final response (post-commit)
        res.locals.__idempotency_key = key;
        next();
    }
    catch (err) {
        console.error('idempotency.middleware', err);
        next(); // don't block the request if idempotency system fails
    }
}
/**
 * Call this after transaction commit to persist response
 * Example usage: await saveIdempotencyResponse(req, res, 201, { appointment })
 */
async function saveIdempotencyResponse(req, res, status, body) {
    const key = res.locals.__idempotency_key;
    if (!key || !req.session)
        return;
    try {
        await (0, db_1.q)(`UPDATE public.hms_idempotency_keys SET response_status = $1, response_body = $2, processed_at = now() WHERE tenant_id = $3 AND key_text = $4`, [status, JSON.stringify(body), req.session.tenantId, key]);
    }
    catch (e) {
        console.error('saveIdempotencyResponse', e);
    }
}
