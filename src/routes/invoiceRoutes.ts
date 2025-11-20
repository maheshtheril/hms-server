// server/src/routes/invoiceRoutes.ts
// POST /api/companies/:companyId/invoices
// This route resolves taxes, injects tax snapshots into line_items, and calls public.hms_create_invoice
// to persist the invoice. It wraps everything in a DB transaction for atomicity.

import express, { Request, Response } from "express";
import { Pool } from "pg";
import { resolveTaxesForInvoice, InvoiceLineIn } from "../services/taxResolver";

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Body:
 * {
 *   tenantId?: "<uuid>",
 *   patientId?: "<uuid>",
 *   encounterId?: "<uuid>",
 *   createdBy?: "<uuid>",
 *   invoiceDate?: "2025-11-20T00:00:00Z",
 *   billingCountryId?: "<uuid>",
 *   lines: [ { description, quantity, unit_price, product_id?, metadata? } ]
 * }
 */
router.post("/api/companies/:companyId/invoices", async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const companyId = req.params.companyId;
    const {
      tenantId = null,
      patientId = null,
      encounterId = null,
      createdBy = null,
      invoiceDate = new Date().toISOString(),
      billingCountryId = null,
      lines,
    } = req.body;

    if (!companyId) return res.status(400).json({ error: "companyId required in path" });
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: "lines[] required in body" });

    // Normalize lines for resolver
    const resolverLines: InvoiceLineIn[] = lines.map((l: any) => ({
      id: l.line_id ?? undefined,
      product_id: l.product_id ?? null,
      product_tax_category: l.metadata?.tax_category ?? null,
      qty: Number(l.quantity ?? l.qty ?? 1),
      unit_price: Number(l.unit_price ?? l.price ?? 0),
      description: l.description ?? l.name ?? "",
      metadata: l.metadata ?? {},
    }));

    // call resolver (reads company_tax_maps + tax tables)
    const resolved = await resolveTaxesForInvoice({
      tenantId,
      companyId,
      invoiceDate,
      billingCountryId,
      transactionType: "sale",
      lines: resolverLines,
    });

    // build line_items payload expected by your DB function
    const lineItemsForDb = resolved.lines.map((rl, idx) => {
      const original = lines[idx] || {};
      const taxes = rl.taxes.map((t) => ({
        tax_type_id: t.tax_type_id,
        tax_type_name: t.tax_type_name ?? null,
        tax_rate_id: t.tax_rate_id,
        tax_rate_name: t.tax_rate_name ?? null,
        rate: t.rate,
        is_percentage: t.is_percentage,
        amount: Number(t.tax_amount),
        is_compound: t.is_compound,
        notes: t.notes ?? null,
      }));
      const net_amount = Number((rl.base_amount + rl.total_tax).toFixed(4));
      return {
        line_id: rl.line_id ?? undefined,
        service_code: original.service_code ?? original.line_ref ?? null,
        product_id: original.product_id ?? null,
        description: original.description ?? original.name ?? "",
        quantity: rl.base_amount && rl.base_amount > 0 ? (original.quantity ?? original.qty ?? 1) : (original.quantity ?? 1),
        unit: original.unit ?? original.uom ?? null,
        unit_price: Number(original.unit_price ?? original.price ?? resolverLines[idx].unit_price ?? 0),
        discount: original.discount ?? null,
        taxes: taxes,
        tax_amount: rl.total_tax,
        net_amount: net_amount,
        metadata: original.metadata ?? {},
      };
    });

    // call DB function inside transaction
    await client.query("BEGIN");

    const fn = `SELECT * FROM public.hms_create_invoice($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::uuid)`;
    const params = [
      tenantId ?? null,
      companyId,
      patientId ?? null,
      encounterId ?? null,
      JSON.stringify(lineItemsForDb),
      createdBy ?? null,
    ];

    const r = await client.query(fn, params);

    await client.query("COMMIT");

    const created = r.rows[0] || {};
    return res.status(201).json({
      invoice_id: created.invoice_id ?? null,
      invoice_number: created.invoice_number ?? null,
      invoice_totals: resolved.invoice_totals,
    });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("create-invoice-error:", err);
    return res.status(500).json({ error: err.message ?? "internal error" });
  } finally {
    client.release();
  }
});

export default router;
