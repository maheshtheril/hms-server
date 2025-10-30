// server/src/routes/hmsProductsAdvanced.ts
import { Router } from "express";
import requireSession from "../middleware/requireSession";
import idempotency, { saveIdempotencyResponse } from "../middleware/idempotency";
import * as svc from "../services/productsAdvancedService";

const router = Router();

/* Create batch */
router.post("/batches", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const b = req.body || {};
    if (!b.product_id || !b.company_id || !b.batch_no) return res.status(400).json({ error: "product_id_company_id_batch_no_required" });
    const r = await svc.createBatch({
      tenantId: s.tenantId,
      companyId: b.company_id,
      productId: b.product_id,
      batch_no: b.batch_no,
      expiry_date: b.expiry_date || null,
      mrp: b.mrp ?? null,
      cost: b.cost ?? null,
      qty: b.qty ?? 0,
      vendor_barcode: b.vendor_barcode ?? null,
      internal_barcode: b.internal_barcode ?? null,
      createdBy: s.userId,
      metadata: b.metadata || {},
    });
    if ((r as any).error) return res.status(500).json(r);
    return res.status(201).json({ batch: r.batch });
  } catch (err) {
    console.error("products.batches.create", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* Receive goods (purchase GRN) */
router.post("/receive", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const b = req.body || {};
    if (!b.product_id || !b.company_id || b.qty === undefined) return res.status(400).json({ error: "product_id_company_id_qty_required" });

    const r = await svc.receiveGoods({
      tenantId: s.tenantId,
      companyId: b.company_id,
      productId: b.product_id,
      batch_no: b.batch_no || undefined,
      expiry_date: b.expiry_date || undefined,
      mrp: b.mrp !== undefined ? Number(b.mrp) : undefined,
      cost: b.cost !== undefined ? Number(b.cost) : undefined,
      qty: Number(b.qty),
      location: b.location || null,
      reference: b.reference || null,
      createdBy: s.userId,
      metadata: b.metadata || {},
    });

    if ((r as any).error) return res.status(500).json(r);
    return res.status(201).json(r);
  } catch (err) {
    console.error("products.receive", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* Issue (sell/consume) */
router.post("/:id/issue", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const productId = req.params.id;
    const b = req.body || {};
    if (b.qty === undefined || !b.company_id) return res.status(400).json({ error: "qty_and_company_id_required" });

    const r = await svc.issueProduct({
      tenantId: s.tenantId,
      companyId: b.company_id,
      productId,
      qty: Number(b.qty),
      location: b.location || null,
      reference: b.reference || null,
      createdBy: s.userId,
      consumeStrategy: b.consumeStrategy || "fifo",
      selected_batch_id: b.selected_batch_id || null,
    });

    if ((r as any).error) {
      if (r.error === "insufficient_stock") return res.status(409).json(r);
      return res.status(500).json(r);
    }
    return res.json(r);
  } catch (err) {
    console.error("products.issue", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* Barcode lookup -> return batch or product */
router.get("/barcode/lookup", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const { company_id, barcode } = req.query;
    if (!company_id || !barcode) return res.status(400).json({ error: "company_id_and_barcode_required" });

    const batch = await svc.findBatchByBarcode({ tenantId: s.tenantId, companyId: company_id, barcode: String(barcode) });
    if (batch) return res.json({ type: "batch", batch });

    // fallback: try product default barcode
    // note: cast svc to any to avoid TS error if the function is not declared in the service types
    const p = await (svc as any).getProductById({ tenantId: s.tenantId, companyId: company_id, productId: String(barcode) }).catch(()=>null);
    if (p) return res.json({ type: "product", product: p });

    return res.status(404).json({ error: "not_found" });
  } catch (err) {
    console.error("products.barcode.lookup", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* Get product stock with batches */
router.get("/:id/stock", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id_required" });
    const r = await svc.getProductStock({ tenantId: s.tenantId, companyId: company_id, productId: req.params.id });
    return res.json(r);
  } catch (err) {
    console.error("products.stock", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* List ledger for product */
router.get("/:id/ledger", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const { company_id, limit } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id_required" });

    // cast svc to any at callsite to avoid TS complaining if the service's type doesn't declare listProductLedger
    const rows = await (svc as any).listProductLedger({
      tenantId: s.tenantId,
      companyId: company_id,
      productId: req.params.id,
      limit: limit ? parseInt(limit,10) : 200
    });

    return res.json({ data: rows });
  } catch (err) {
    console.error("products.ledger", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
