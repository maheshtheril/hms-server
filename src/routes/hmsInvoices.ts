// server/src/routes/hmsInvoices.ts
import { Router, Request, Response } from "express";
import { q } from "../db"; // your pg helper: q(sql, params)
import requireSession from "../middleware/requireSession";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Helper: extract tenant & company from session (adjust to your session shape)
function tenantCompanyFromReq(req: Request) {
  const tenant_id = req.session?.tenant_id;
  const company_id = req.session?.active_company_id;
  return { tenant_id, company_id };
}

/**
 * List invoices (paginated + filters)
 * GET /hms/invoices?limit=25&offset=0&status=paid&patient_id=...
 */
router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const limit = Math.min(100, Number(req.query.limit || 25));
    const offset = Number(req.query.offset || 0);

    const filters: string[] = ["tenant_id = $1", "company_id = $2"];
    const params: any[] = [tenant_id, company_id];
    let idx = params.length;

    if (req.query.status) {
      idx += 1;
      filters.push(`status = $${idx}`);
      params.push(String(req.query.status));
    }
    if (req.query.patient_id) {
      idx += 1;
      filters.push(`patient_id = $${idx}`);
      params.push(String(req.query.patient_id));
    }
    if (req.query.q) {
      idx += 1;
      filters.push(`(invoice_number ILIKE $${idx} OR CAST(id AS text) ILIKE $${idx})`);
      params.push(`%${String(req.query.q)}%`);
    }

    idx += 1;
    params.push(limit);
    idx += 1;
    params.push(offset);

    const sql = `
      SELECT id, invoice_number, patient_id, encounter_id, issued_at, due_at, currency,
             subtotal, total_tax, total_discount, total, total_paid, status, locked, created_at, updated_at
      FROM public.hms_invoice
      WHERE ${filters.join(" AND ")}
      ORDER BY issued_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const invoices = await q(sql, params);
    res.json({ success: true, data: invoices.rows });
  } catch (err) {
    console.error("GET /hms/invoices error:", err);
    res.status(500).json({ success: false, error: "Failed to list invoices" });
  }
});

/**
 * Create invoice
 * POST /hms/invoices
 * body: { patient_id, encounter_id, line_items (jsonb), due_at, currency }
 */
router.post("/", requireSession, async (req: Request, res: Response) => {
  const { tenant_id, company_id } = tenantCompanyFromReq(req);
  const { patient_id = null, encounter_id = null, line_items = [], due_at = null, currency = "INR" } = req.body;
  const created_by = req.session?.user_id || null;

  try {
    // Use DB helper function hms_create_invoice to allocate invoice_number and create row
    const result = await q(
      `SELECT * FROM public.hms_create_invoice($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::uuid)`,
      [tenant_id, company_id, patient_id, encounter_id, JSON.stringify(line_items), created_by]
    );

    // hms_create_invoice returns (invoice_id, invoice_number)
    const created = result.rows[0];
    const invoice_id = created.invoice_id || created.id || null;
    const invoice_number = created.invoice_number || null;

    if (!invoice_id) {
      return res.status(500).json({ success: false, error: "Failed to create invoice" });
    }

    // Optionally update due_at/currency if provided
    if (due_at || currency) {
      const updates: string[] = [];
      const params: any[] = [tenant_id, company_id, invoice_id];
      let idx = params.length;

      if (due_at) {
        idx += 1;
        updates.push(`due_at = $${idx}`);
        params.push(due_at);
      }
      if (currency) {
        idx += 1;
        updates.push(`currency = $${idx}`);
        params.push(currency);
      }

      if (updates.length > 0) {
        await q(
          `UPDATE public.hms_invoice SET ${updates.join(", ")}, updated_at = now() 
           WHERE tenant_id = $1 AND company_id = $2 AND id = $3`,
          params
        );
      }
    }

    // Return fresh invoice row
    const invoiceRow = await q(
      `SELECT * FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`,
      [tenant_id, company_id, invoice_id]
    );

    res.status(201).json({ success: true, data: invoiceRow.rows[0] });
  } catch (err) {
    console.error("POST /hms/invoices error:", err);
    res.status(500).json({ success: false, error: "Failed to create invoice" });
  }
});

/**
 * Get invoice by id
 * GET /hms/invoices/:id
 */
router.get("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const id = req.params.id;

    const invoice = await q(
      `SELECT i.*, COALESCE(jsonb_agg(l.*) FILTER (WHERE l.id IS NOT NULL), '[]') AS normalized_lines
       FROM public.hms_invoice i
       LEFT JOIN public.hms_invoice_lines l ON l.invoice_id = i.id AND l.tenant_id = i.tenant_id AND l.company_id = i.company_id
       WHERE i.tenant_id = $1 AND i.company_id = $2 AND i.id = $3
       GROUP BY i.id`,
      [tenant_id, company_id, id]
    );

    if (invoice.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }

    res.json({ success: true, data: invoice.rows[0] });
  } catch (err) {
    console.error("GET /hms/invoices/:id error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch invoice" });
  }
});

/**
 * Update invoice (only editable when not locked/posted)
 * PATCH /hms/invoices/:id
 * body: { due_at, line_items, locked, billing_metadata, status (careful) }
 */
router.patch("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const id = req.params.id;
    const { due_at, line_items, locked, billing_metadata } = req.body;

    // fetch current invoice to check locked status
    const cur = await q(
      `SELECT locked FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`,
      [tenant_id, company_id, id]
    );
    if (cur.rowCount === 0) {
      return res.status(404).json({ success: false, error: "Invoice not found" });
    }
    const isLocked = cur.rows[0].locked;

    // allow some fields to be updated even if locked? By default disallow edits when locked
    if (isLocked) {
      return res.status(400).json({ success: false, error: "Invoice is locked and cannot be modified" });
    }

    const updates: string[] = [];
    const params: any[] = [tenant_id, company_id, id];
    let idx = params.length;

    if (due_at !== undefined) {
      idx += 1;
      updates.push(`due_at = $${idx}`);
      params.push(due_at);
    }
    if (line_items !== undefined) {
      idx += 1;
      updates.push(`line_items = $${idx}::jsonb`);
      params.push(JSON.stringify(line_items));
    }
    if (locked !== undefined) {
      idx += 1;
      updates.push(`locked = $${idx}`);
      params.push(locked === true);
    }
    if (billing_metadata !== undefined) {
      idx += 1;
      updates.push(`billing_metadata = $${idx}::jsonb`);
      params.push(JSON.stringify(billing_metadata));
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: "No updatable fields provided" });
    }

    const sql = `
      UPDATE public.hms_invoice
      SET ${updates.join(", ")}, updated_at = now()
      WHERE tenant_id = $1 AND company_id = $2 AND id = $3
      RETURNING *
    `;

    const updated = await q(sql, params);
    res.json({ success: true, data: updated.rows[0] });
  } catch (err) {
    console.error("PATCH /hms/invoices/:id error:", err);
    res.status(500).json({ success: false, error: "Failed to update invoice" });
  }
});

/**
 * Delete invoice (soft-delete not implemented here; this will remove invoice and cascade lines/payments)
 * DELETE /hms/invoices/:id
 */
router.delete("/:id", requireSession, async (req: Request, res: Response) => {
  try {
    const { tenant_id, company_id } = tenantCompanyFromReq(req);
    const id = req.params.id;

    // disallow delete if invoice locked or paid
    const cur = await q(
      `SELECT locked, status, total_paid, total FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`,
      [tenant_id, company_id, id]
    );
    if (cur.rowCount === 0) return res.status(404).json({ success: false, error: "Invoice not found" });

    const { locked, status, total_paid } = cur.rows[0];
    if (locked || (total_paid && Number(total_paid) > 0) || status === "paid") {
      return res.status(400).json({ success: false, error: "Cannot delete a locked or paid invoice" });
    }

    await q(`DELETE FROM public.hms_invoice WHERE tenant_id = $1 AND company_id = $2 AND id = $3`, [
      tenant_id,
      company_id,
      id,
    ]);

    res.json({ success: true, message: "Invoice deleted" });
  } catch (err) {
    console.error("DELETE /hms/invoices/:id error:", err);
    res.status(500).json({ success: false, error: "Failed to delete invoice" });
  }
});

export default router;
