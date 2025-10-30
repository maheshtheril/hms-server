// server/src/routes/hmsInvoicePayments.ts
import { Router, Request, Response } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";
import { v4 as uuidv4 } from "uuid";

const router = Router();

function tenantCompanyFromReq(req: Request) {
  const tenant_id = req.session?.tenant_id;
  const company_id = req.session?.active_company_id;
  return { tenant_id, company_id };
}

/**
 * List payments for an invoice or across tenant/company
 * GET /hms/invoice-payments?invoice_id=...&limit=&offset=
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const limit = Math.min(200, Number(req.query.limit || 50));
    const offset = Number(req.query.offset || 0);

    const invoice_id = req.query.invoice_id ? String(req.query.invoice_id) : null;

    const params: any[] = [tenant_id, company_id, limit, offset];
    let sql = `
      SELECT id, invoice_id, payment_reference, paid_at, amount, currency, method, metadata, created_by, created_at
      FROM public.hms_invoice_payments
      WHERE tenant_id = $1 AND company_id = $2
    `;
    if (invoice_id) {
      sql += ` AND invoice_id = $5`;
      params.splice(3, 0, invoice_id); // put invoice_id as $5; keep limit/offset after
    }
    sql += ` ORDER BY paid_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const rows = await q(sql, params);
    res.json({ success: true, data: rows.rows });
  } catch (err) {
    console.error("GET /hms/invoice-payments error:", err);
    res.status(500).json({ success: false, error: "Failed to list payments" });
  }
});

/**
 * Create payment for an invoice (idempotent via optional payment_reference)
 * POST /hms/invoice-payments
 * body: { invoice_id, payment_reference (optional), amount, method, paid_at, currency, metadata }
 */
router.post("/", requireSession, async (req: Request, res: Response) => {
  const { tenant_id, company_id } = tenantCompanyFromReq(req);
  const { invoice_id, payment_reference = null, amount, method = "Cash", paid_at = null, currency = "INR", metadata = {} } =
    req.body;
  const created_by = req.session?.user_id || null;

  if (!invoice_id || !amount) {
    return res.status(400).json({ success: false, error: "invoice_id and amount are required" });
  }

  const client = await q("BEGIN"); // q is generic - if it returns a client, adapt; otherwise use plain transaction SQL

  try {
    // idempotency: if payment_reference provided, ensure uniqueness per tenant+company handled by unique index
    if (payment_reference) {
      // check existing
      const existing = await q(
        `SELECT * FROM public.hms_invoice_payments WHERE tenant_id = $1 AND company_id = $2 AND payment_reference = $3`,
        [tenant_id, company_id, payment_reference]
      );
      if (existing.rowCount > 0) {
        return res.status(200).json({ success: true, data: existing.rows[0], idempotent: true });
      }
    }

    // ensure invoice exists and is within same tenant/company
    const invoiceRes = await q(`SELECT id, total, total_paid, locked FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`, [
      tenant_id,
      company_id,
      invoice_id,
    ]);
    if (invoiceRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }
    const invoice = invoiceRes.rows[0];
    if (invoice.locked) {
      return res.status(400).json({ success: false, error: "Invoice is locked and cannot receive payments" });
    }

    // Insert payment
    const insertRes = await q(
      `INSERT INTO public.hms_invoice_payments
       (id, tenant_id, company_id, invoice_id, payment_reference, paid_at, amount, currency, method, metadata, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::hms_payment_method, $10::jsonb, $11, now())
       RETURNING *`,
      [uuidv4(), tenant_id, company_id, invoice_id, payment_reference, paid_at || new Date().toISOString(), amount, currency, method, JSON.stringify(metadata), created_by]
    );

    // Optionally, if you support hms_payment_allocations, create allocation row(s) here.
    // For now we assume full allocation to the invoice:
    // (You can extend to support partial or multi-invoice allocations.)

    // Commit
    await q("COMMIT");

    // Recompute invoice totals triggered by DB trigger; fetch fresh invoice and return
    const updatedInvoice = await q(`SELECT * FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`, [
      tenant_id,
      company_id,
      invoice_id,
    ]);

    res.status(201).json({ success: true, payment: insertRes.rows[0], invoice: updatedInvoice.rows[0] });
  } catch (err) {
    console.error("POST /hms/invoice-payments error:", err);
    try {
      await q("ROLLBACK");
    } catch (rbErr) {
      console.error("rollback error:", rbErr);
    }
    res.status(500).json({ success: false, error: "Failed to record payment" });
  }
});

/**
 * Get a single payment
 * GET /hms/invoice-payments/:id
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const id = req.params.id;

    const p = await q(`SELECT * FROM public.hms_invoice_payments WHERE tenant_id = $1 AND company_id = $2 AND id = $3`, [
      tenant_id,
      company_id,
      id,
    ]);
    if (p.rowCount === 0) return res.status(404).json({ success: false, error: "Payment not found" });

    res.json({ success: true, data: p.rows[0] });
  } catch (err) {
    console.error("GET /hms/invoice-payments/:id error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch payment" });
  }
});

/**
 * Delete a payment (rare; only allowed when not reconciled/locked)
 * DELETE /hms/invoice-payments/:id
 */
router.delete("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const id = req.params.id;

    // fetch payment + invoice
    const pr = await q(`SELECT p.*, i.locked AS invoice_locked FROM public.hms_invoice_payments p JOIN public.hms_invoice i ON i.id = p.invoice_id WHERE p.tenant_id = $1 AND p.company_id = $2 AND p.id = $3`, [
      tenant_id,
      company_id,
      id,
    ]);
    if (pr.rowCount === 0) return res.status(404).json({ success: false, error: "Payment not found" });
    const payment = pr.rows[0];
    if (payment.invoice_locked) return res.status(400).json({ success: false, error: "Invoice locked; cannot delete payment" });

    await q(`DELETE FROM public.hms_invoice_payments WHERE tenant_id = $1 AND company_id = $2 AND id = $3`, [tenant_id, company_id, id]);
    res.json({ success: true, message: "Payment deleted" });
  } catch (err) {
    console.error("DELETE /hms/invoice-payments/:id error:", err);
    res.status(500).json({ success: false, error: "Failed to delete payment" });
  }
});

export default router;
