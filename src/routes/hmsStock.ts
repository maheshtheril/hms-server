// server/src/routes/hmsStock.ts
import { Router } from "express";
import requireSession from "../middleware/requireSession";
import * as svc from "../services/stockService";

const router = Router();

/**
 * GET /hms/stock
 * Query:
 *  company_id (required),
 *  product_id, batch_id, movement_type, reference, from, to, q, limit, offset
 */
router.get("/", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const qParams = req.query || {};
    const companyId = qParams.company_id;
    if (!companyId) return res.status(400).json({ error: "company_id_required" });

    const rows = await svc.listStockLedger({
      tenantId: s.tenantId,
      companyId,
      product_id: qParams.product_id ?? null,
      batch_id: qParams.batch_id ?? null,
      movement_type: qParams.movement_type ?? null,
      reference: qParams.reference ?? null,
      from: qParams.from ?? null,
      to: qParams.to ?? null,
      q: qParams.q ?? null,
      limit: qParams.limit ? parseInt(qParams.limit, 10) : undefined,
      offset: qParams.offset ? parseInt(qParams.offset, 10) : undefined,
    });

    return res.json({ data: rows });
  } catch (err) {
    console.error("stock.list", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * GET /hms/stock/summary
 * Query: company_id (required), q, limit, offset
 * Returns aggregated qty per product
 */
router.get("/summary", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const companyId = req.query.company_id;
    if (!companyId) return res.status(400).json({ error: "company_id_required" });
    const rows = await svc.summarizeStockByProduct({
      tenantId: s.tenantId,
      companyId,
      q: req.query.q ?? null,
      limit: req.query.limit ? parseInt(req.query.limit,10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset,10) : undefined,
    });
    return res.json({ data: rows });
  } catch (err) {
    console.error("stock.summary", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/**
 * GET /hms/stock/export
 * Query same as GET / (company_id required)
 * Returns CSV content
 */
router.get("/export", requireSession, async (req: any, res) => {
  try {
    const s = req.session;
    const qParams = req.query || {};
    const companyId = qParams.company_id;
    if (!companyId) return res.status(400).json({ error: "company_id_required" });

    const csv = await svc.exportLedgerCsv({
      tenantId: s.tenantId,
      companyId,
      product_id: qParams.product_id ?? null,
      batch_id: qParams.batch_id ?? null,
      movement_type: qParams.movement_type ?? null,
      reference: qParams.reference ?? null,
      from: qParams.from ?? null,
      to: qParams.to ?? null,
      q: qParams.q ?? null,
      limit: qParams.limit ? parseInt(qParams.limit, 10) : 10000,
      offset: qParams.offset ? parseInt(qParams.offset, 10) : 0,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="stock_ledger_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error("stock.export", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
