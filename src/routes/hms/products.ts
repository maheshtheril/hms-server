/**
 * server/src/routes/hms/products.ts
 * Express router for hms_product (list, get, create, update, soft-delete)
 *
 * Improved POST /: idempotent create + optional initial_stock (batch + ledger) in one transaction.
 */

import { Router, Request } from "express";
import { pool } from "../../db";
import sessionLoader from "../../middleware/sessionLoader";

const router = Router();
const DEBUG = true;

/* -------------------------
 * Helpers
 * ------------------------ */
type UserLike = { id?: string; tenant_id?: string | null; is_platform_admin?: boolean; is_tenant_admin?: boolean; is_admin?: boolean; [k:string]: any };

function coerceBool(v: any): boolean {
  return v === true || v === "true" || v === 1 || v === "1" || v === "t" || v === "T";
}
function normalizeUserShape(raw: any): UserLike {
  return {
    id: raw?.id ?? raw?.user_id ?? raw?.userId,
    tenant_id: raw?.tenant_id ?? raw?.tenantId ?? raw?.tenant ?? null,
    is_platform_admin: coerceBool(raw?.is_platform_admin ?? raw?.isPlatformAdmin ?? raw?.platformAdmin),
    is_tenant_admin: coerceBool(raw?.is_tenant_admin ?? raw?.isTenantAdmin ?? raw?.tenantAdmin),
    is_admin: coerceBool(raw?.is_admin ?? raw?.isAdmin),
    ...raw,
  };
}
function getUser(req: Request): UserLike {
  const u = (req as any).user;
  const s = (req as any).session;
  if (u && typeof u === "object" && Object.keys(u).length) return normalizeUserShape(u);
  if (s && typeof s === "object" && Object.keys(s).length) return normalizeUserShape(s);
  return {};
}
function safeUUID(v: any): string | null {
  if (!v || typeof v !== "string") return null;
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return re.test(v) ? v : null;
}

/* -------------------------
 * Param validator (id)
 * ------------------------ */
router.param("id", (req, res, next, id) => {
  const valid = safeUUID(id);
  if (!valid) {
    if (DEBUG) console.warn("[hms_product] invalid id:", id);
    return res.status(400).json({ error: "invalid_id", reason: "id_must_be_uuid" });
  }
  (req.params as any)._validatedId = valid;
  next();
});

/* -------------------------
 * GET /api/hms/products
 */
router.get("/", sessionLoader.requireSession, async (req, res) => {
  const r = req as any;
  const session = r.session ?? {};
  const user = getUser(req);
  const tenantId = safeUUID(session?.tenant_id ?? user?.tenant_id) ?? null;
  const companyId = safeUUID(String(req.query.company_id ?? "")) ?? null;
  const q = String(req.query.q ?? "").trim();
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 100)));
  const offset = (page - 1) * limit;
  const includeDeleted = String(req.query.include_deleted ?? "0") === "1";

  if (!tenantId) return res.status(401).json({ error: "unauthenticated" });
  if (!companyId) return res.status(400).json({ error: "company_id_required" });

  const cx = await pool.connect();
  try {
    // ensure company belongs to tenant (simple guard)
    const compCheck = await cx.query(
      `SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [companyId, tenantId]
    );
    if (!compCheck.rows.length) return res.status(403).json({ error: "forbidden_company" });

    const params: any[] = [tenantId, companyId];
    let where = `WHERE tenant_id = $1 AND company_id = $2`;
    if (q) {
      params.push(`%${q}%`);
      params.push(`%${q}%`);
      where += ` AND (name ILIKE $${params.length - 1} OR sku ILIKE $${params.length})`;
    }
    if (!includeDeleted) {
      where += ` AND deleted_at IS NULL`;
    }
    params.push(limit, offset);

    const sql = `
      SELECT id, tenant_id, company_id, sku, name, description, is_stockable, is_service,
             uom, valuation_method, price, currency, default_cost, metadata, created_at,
             created_by, updated_at, updated_by, deleted_at, is_active, default_barcode, barcode_type
      FROM public.hms_product
      ${where}
      ORDER BY name ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countSql = `SELECT COUNT(*)::int as total FROM public.hms_product ${where}`;

    const [rowsRes, countRes] = await Promise.all([cx.query(sql, params), cx.query(countSql, params.slice(0, params.length - 2))]);

    const rows = rowsRes.rows.map((r: any) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      company_id: r.company_id,
      sku: r.sku,
      name: r.name,
      description: r.description,
      is_stockable: !!r.is_stockable,
      is_service: !!r.is_service,
      uom: r.uom,
      valuation_method: r.valuation_method,
      price: r.price !== null ? Number(r.price) : null,
      currency: r.currency,
      default_cost: r.default_cost !== null ? Number(r.default_cost) : null,
      metadata: r.metadata ?? {},
      created_at: r.created_at,
      created_by: r.created_by,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
      deleted_at: r.deleted_at,
      is_active: !!r.is_active,
      default_barcode: r.default_barcode,
      barcode_type: r.barcode_type,
    }));

    return res.json({ ok: true, data: rows, total: countRes.rows?.[0]?.total ?? rows.length });
  } catch (err: any) {
    console.error("[GET /api/hms/products] error:", err);
    return res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});

/* -------------------------
 * GET /api/hms/products/:id
 */
router.get("/:id", sessionLoader.requireSession, async (req, res) => {
  const id = (req.params as any)._validatedId;
  const r = req as any;
  const session = r.session ?? {};
  const tenantId = safeUUID(session?.tenant_id) ?? null;
  if (!tenantId) return res.status(401).json({ error: "unauthenticated" });

  const cx = await pool.connect();
  try {
    const { rows } = await cx.query(
      `SELECT id, tenant_id, company_id, sku, name, description, is_stockable, is_service,
              uom, valuation_method, price, currency, default_cost, metadata, created_at,
              created_by, updated_at, updated_by, deleted_at, is_active, default_barcode, barcode_type
       FROM public.hms_product WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
      [id, tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, data: rows[0] });
  } catch (err: any) {
    console.error("[GET /api/hms/products/:id] error:", err);
    return res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});

/* -------------------------
 * POST /api/hms/products
 * Idempotent create + optional initial_stock (single batch + ledger) in same transaction.
 *
 * Accepts optional Idempotency-Key header (preferred) or idempotency_key in body.
 * Optional body.initial_stock = { qty, batch_no?, expiry?, cost?, mrp?, vendor_barcode?, internal_barcode?, location?, metadata? }
 */
router.post("/", sessionLoader.requireSession, async (req, res) => {
  const r = req as any;
  const session = r.session ?? {};
  const user = getUser(req);
  const tenantId = safeUUID(session?.tenant_id ?? user?.tenant_id) ?? null;
  const userId = safeUUID(session?.user_id ?? user?.id) ?? null;

  if (!tenantId || !userId) return res.status(401).json({ error: "unauthenticated" });

  // idempotency key: prefer header, fallback to body
  const idempKey = (String(req.header("Idempotency-Key") || req.body?.idempotency_key || "").trim()) || null;

  const sku = (req.body?.sku ?? "").toString().trim();
  const name = (req.body?.name ?? "").toString().trim();
  const companyId = safeUUID(req.body?.company_id ?? "") ?? null;
  const description = req.body?.description ?? null;
  const is_stockable = coerceBool(req.body?.is_stockable ?? true);
  const is_service = coerceBool(req.body?.is_service ?? false);
  const uom = (req.body?.uom ?? "each").toString();
  const valuation_method = (req.body?.valuation_method ?? "fifo").toString();
  const price = typeof req.body?.price !== "undefined" ? Number(req.body.price) : 0;
  const currency = (req.body?.currency ?? "USD").toString();
  const default_cost = typeof req.body?.default_cost !== "undefined" ? Number(req.body.default_cost) : 0;
  const metadata = req.body?.metadata ?? {};
  const initialStock = req.body?.initial_stock ?? null; // optional object

  if (!sku) return res.status(400).json({ error: "sku_required" });
  if (!name) return res.status(400).json({ error: "name_required" });
  if (!companyId) return res.status(400).json({ error: "company_id_required" });

  const cx = await pool.connect();
  try {
    // Verify company belongs to tenant
    const compCheck = await cx.query(
      `SELECT id FROM public.company WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [companyId, tenantId]
    );
    if (!compCheck.rows.length) return res.status(403).json({ error: "forbidden_company" });

    // If idempotency key provided, check prior outcome before heavy work
    if (idempKey) {
      const ik = await cx.query(
        `SELECT id, processed_at, response_status, response_body
         FROM public.hms_idempotency_keys
         WHERE tenant_id = $1 AND key_text = $2
         LIMIT 1`,
        [tenantId, idempKey]
      );
      if (ik.rows.length) {
        const row = ik.rows[0];
        if (row.processed_at) {
          // replay stored response
          const status = row.response_status ?? 200;
          const body = row.response_body ?? { ok: true };
          return res.status(status).json(body);
        }
        // key exists but not processed -> continue (we'll take locks inside transaction)
      }
    }

    // Begin tx
    await cx.query("BEGIN");

    // Insert or lock idempotency row (if provided)
    let idempRowId: string | null = null;
    if (idempKey) {
      // try insert; if conflict, SELECT FOR UPDATE to wait other concurrent worker
      const ikInsSql = `
        INSERT INTO public.hms_idempotency_keys
          (tenant_id, key_text, created_by, created_at, request_method, request_path, request_body)
        VALUES ($1,$2,$3, now(), $4, $5, $6)
        ON CONFLICT (tenant_id, key_text) DO NOTHING
        RETURNING id
      `;
      const ikRes = await cx.query(ikInsSql, [
        tenantId,
        idempKey,
        userId,
        String(req.method ?? "POST"),
        String(req.path ?? req.url ?? "/api/hms/products"),
        req.body ?? {},
      ]);
      if (ikRes.rows.length) {
        idempRowId = ikRes.rows[0].id;
      } else {
        // existing row -> lock it so parallel requests wait here and then replay stored response
        const locked = await cx.query(
          `SELECT id, processed_at, response_status, response_body FROM public.hms_idempotency_keys WHERE tenant_id=$1 AND key_text=$2 LIMIT 1 FOR UPDATE`,
          [tenantId, idempKey]
        );
        if (locked.rows.length) {
          const lr = locked.rows[0];
          if (lr.processed_at) {
            // already processed by other worker -> commit and replay
            await cx.query("COMMIT");
            return res.status(lr.response_status ?? 200).json(lr.response_body ?? { ok: true });
          }
          idempRowId = lr.id;
        }
      }
    }

    // Insert product
    const insertSql = `
      INSERT INTO public.hms_product
        (tenant_id, company_id, sku, name, description, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, metadata, created_at, created_by, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14, true)
      RETURNING id, tenant_id, company_id, sku, name, description, is_stockable, is_service,
                uom, valuation_method, price, currency, default_cost, metadata, created_at,
                created_by, updated_at, updated_by, deleted_at, is_active, default_barcode, barcode_type
    `;
    const params = [tenantId, companyId, sku, name, description, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, metadata, userId];

    let productRow;
    try {
      const { rows } = await cx.query(insertSql, params);
      productRow = rows[0];
    } catch (e: any) {
      if (e?.code === "23505") {
        // duplicate SKU - rollback and return 409
        await cx.query("ROLLBACK");
        return res.status(409).json({ error: "duplicate_sku" });
      }
      throw e;
    }

    // Optionally seed initial stock (single batch + ledger) inside same tx
    const insertedBatches: any[] = [];
    if (is_stockable && initialStock && typeof initialStock.qty !== "undefined" && Number(initialStock.qty) > 0) {
      const qty = Number(initialStock.qty);
      const batchNo = (initialStock.batch_no ?? `INIT-${Date.now()}`).toString();
      const expiry = initialStock.expiry ?? null;
      const batchCost = typeof initialStock.cost !== "undefined" ? Number(initialStock.cost) : default_cost;
      const mrp = typeof initialStock.mrp !== "undefined" ? Number(initialStock.mrp) : null;
      const vendorBarcode = initialStock.vendor_barcode ?? null;
      const internalBarcode = initialStock.internal_barcode ?? null;
      const batchMetadata = initialStock.metadata ?? {};

      const batchSql = `
        INSERT INTO public.hms_product_batch
          (tenant_id, company_id, product_id, batch_no, expiry_date, mrp, cost, qty_on_hand, vendor_barcode, internal_barcode, created_at, created_by, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11, $12)
        RETURNING id, batch_no, qty_on_hand, cost
      `;
      const batchParams = [tenantId, companyId, productRow.id, batchNo, expiry, mrp, batchCost, qty, vendorBarcode, internalBarcode, userId, batchMetadata];
      const bRes = await cx.query(batchSql, batchParams);
      const batchRow = bRes.rows[0];
      insertedBatches.push(batchRow);

      // Compute running balance for product by summing change_qty in ledger
      const balRes = await cx.query(
        `SELECT COALESCE(SUM(change_qty),0)::numeric AS bal FROM public.hms_product_stock_ledger WHERE tenant_id=$1 AND company_id=$2 AND product_id=$3`,
        [tenantId, companyId, productRow.id]
      );
      const previousBalance = Number(balRes.rows?.[0]?.bal ?? 0);
      const newBalance = previousBalance + qty;

      const ledgerSql = `
        INSERT INTO public.hms_product_stock_ledger
          (tenant_id, company_id, product_id, location, change_qty, balance_qty, movement_type, reference, cost, created_at, created_by, metadata, batch_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10, $11, $12)
        RETURNING id
      `;
      const ledgerParams = [
        tenantId,
        companyId,
        productRow.id,
        initialStock.location ?? null,
        qty,
        newBalance,
        "initial",
        `initial_batch:${batchRow.batch_no}`,
        batchCost,
        userId,
        { source: "product_create" },
        batchRow.id,
      ];
      await cx.query(ledgerSql, ledgerParams);
    }

    // commit tx
    await cx.query("COMMIT");

    // Build response body including seeded batches (if any)
    const responseBody = { ok: true, data: { ...productRow, batches: insertedBatches } };
    const responseStatus = 201;

    // Persist idempotency response (best-effort): update idempotency row to mark processed and store response
    if (idempKey) {
      try {
        const scx = await pool.connect();
        try {
          await scx.query("BEGIN");
          await scx.query(
            `UPDATE public.hms_idempotency_keys
             SET response_status = $1, response_body = $2, processed_at = now(), processed_by = $3
             WHERE tenant_id = $4 AND key_text = $5`,
            [responseStatus, responseBody, userId, tenantId, idempKey]
          );
          await scx.query("COMMIT");
        } catch (e) {
          try { await scx.query("ROLLBACK"); } catch {} // ignore
          console.error("Failed to persist idempotency result:", e);
        } finally {
          scx.release();
        }
      } catch (e) {
        console.error("Idempotency persistence outer error:", e);
      }
    }

    return res.status(responseStatus).json(responseBody);
  } catch (err: any) {
    try { await cx.query("ROLLBACK"); } catch (e) { /* ignore */ }
    console.error("[POST /api/hms/products] improved create error:", err);
    return res.status(500).json({ error: "internal_server_error", detail: err?.message });
  } finally {
    cx.release();
  }
});

/* -------------------------
 * PUT /api/hms/products/:id
 * (unchanged update behavior)
 */
router.put("/:id", sessionLoader.requireSession, async (req, res) => {
  const id = (req.params as any)._validatedId;
  const r = req as any;
  const session = r.session ?? {};
  const user = getUser(req);
  const tenantId = safeUUID(session?.tenant_id ?? user?.tenant_id) ?? null;
  const userId = safeUUID(session?.user_id ?? user?.id) ?? null;

  if (!tenantId || !userId) return res.status(401).json({ error: "unauthenticated" });

  const sku = req.body?.sku ?? null;
  const name = req.body?.name ?? null;
  const description = req.body?.description ?? null;
  const is_stockable = typeof req.body?.is_stockable === "undefined" ? null : coerceBool(req.body.is_stockable);
  const is_service = typeof req.body?.is_service === "undefined" ? null : coerceBool(req.body.is_service);
  const price = typeof req.body?.price === "undefined" ? null : Number(req.body.price);
  const currency = req.body?.currency ?? null;
  const default_cost = typeof req.body?.default_cost === "undefined" ? null : Number(req.body.default_cost);
  const metadata = typeof req.body?.metadata === "undefined" ? null : req.body.metadata;

  const cx = await pool.connect();
  try {
    const existing = await cx.query(`SELECT id, tenant_id, company_id FROM public.hms_product WHERE id=$1 LIMIT 1`, [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;
    if (srcTenant !== tenantId) return res.status(403).json({ error: "forbidden_tenant_mismatch" });

    // Build update dynamically
    const updates: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (sku !== null) { updates.push(`sku = $${idx++}`); params.push(sku); }
    if (name !== null) { updates.push(`name = $${idx++}`); params.push(name); }
    if (description !== null) { updates.push(`description = $${idx++}`); params.push(description); }
    if (is_stockable !== null) { updates.push(`is_stockable = $${idx++}`); params.push(is_stockable); }
    if (is_service !== null) { updates.push(`is_service = $${idx++}`); params.push(is_service); }
    if (price !== null) { updates.push(`price = $${idx++}`); params.push(price); }
    if (currency !== null) { updates.push(`currency = $${idx++}`); params.push(currency); }
    if (default_cost !== null) { updates.push(`default_cost = $${idx++}`); params.push(default_cost); }
    if (metadata !== null) { updates.push(`metadata = $${idx++}`); params.push(metadata); }

    if (!updates.length) return res.status(400).json({ error: "nothing_to_update" });

    params.push(userId); // updated_by
    params.push(id); // WHERE id

    const sql = `
      UPDATE public.hms_product
      SET ${updates.join(", ")}, updated_at = now(), updated_by = $${idx++}
      WHERE id = $${idx}
      RETURNING id, tenant_id, company_id, sku, name, description, is_stockable, is_service,
                uom, valuation_method, price, currency, default_cost, metadata, created_at,
                created_by, updated_at, updated_by, deleted_at, is_active, default_barcode, barcode_type
    `;

    try {
      const { rows } = await cx.query(sql, params);
      if (!rows.length) return res.status(404).json({ error: "not_found" });
      return res.json({ ok: true, data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ error: "duplicate_sku" });
      throw e;
    }
  } catch (err: any) {
    console.error("[PUT /api/hms/products/:id] error:", err);
    return res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});

/* -------------------------
 * DELETE /api/hms/products/:id -> soft-delete
 */
router.delete("/:id", sessionLoader.requireSession, async (req, res) => {
  const id = (req.params as any)._validatedId;
  const r = req as any;
  const session = r.session ?? {};
  const user = getUser(req);
  const tenantId = safeUUID(session?.tenant_id ?? user?.tenant_id) ?? null;
  const userId = safeUUID(session?.user_id ?? user?.id) ?? null;

  if (!tenantId || !userId) return res.status(401).json({ error: "unauthenticated" });

  const cx = await pool.connect();
  try {
    const existing = await cx.query(`SELECT id, tenant_id FROM public.hms_product WHERE id=$1 LIMIT 1`, [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;
    if (srcTenant !== tenantId) return res.status(403).json({ error: "forbidden_tenant_mismatch" });

    await cx.query(
      `UPDATE public.hms_product SET deleted_at = now(), updated_at = now(), is_active = false, updated_by = $1 WHERE id = $2`,
      [userId, id]
    );
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[DELETE /api/hms/products/:id] error:", err);
    return res.status(500).json({ error: "internal_server_error" });
  } finally {
    cx.release();
  }
});

export default router;
