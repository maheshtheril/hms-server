// server/src/services/taxResolver.ts
// Production-ready tax resolver that reads your schema's company_tax_maps, tax_rates, tax_types
// and computes taxes per invoice line. Returns resolved tax snapshot suitable for persisting.

import { Pool } from "pg";

export type InvoiceLineIn = {
  id?: string;
  product_id?: string | null;
  product_tax_category?: string | null;
  qty: number;
  unit_price: number | string;
  description?: string;
  metadata?: any;
};

export type ResolvedTaxLine = {
  tax_type_id: string;
  tax_type_name?: string;
  tax_rate_id: string;
  tax_rate_name?: string;
  rate: number;
  is_percentage: boolean;
  is_compound: boolean;
  base_amount: number;
  tax_amount: number;
  rounding_applied: number | null;
  notes?: string | null;
};

export type ResolvedInvoiceLine = {
  line_id?: string | undefined;
  base_amount: number;
  total_tax: number;
  total_amount: number;
  taxes: ResolvedTaxLine[];
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // you can add ssl or other options here if needed
});

function toNumber(v: any) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * resolveTaxesForInvoice
 * - tenantId: optional tenant id (used for multi-tenant setups)
 * - companyId: required
 * - invoiceDate: optional ISO date or Date
 * - billingCountryId: optional uuid used to match country-specific tax maps
 * - transactionType: 'sale' | 'purchase' (not used for filtering by default but included for extensibility)
 * - lines: invoice lines to resolve
 */
export async function resolveTaxesForInvoice({
  tenantId = null,
  companyId,
  invoiceDate = new Date().toISOString(),
  billingCountryId = null,
  transactionType = "sale",
  lines,
}: {
  tenantId?: string | null;
  companyId: string;
  invoiceDate?: string | Date;
  billingCountryId?: string | null;
  transactionType?: "sale" | "purchase";
  lines: InvoiceLineIn[];
}): Promise<{
  lines: ResolvedInvoiceLine[];
  invoice_totals: { subtotal: number; total_tax: number; total: number };
}> {
  if (!companyId) throw new Error("companyId required");

  const client = await pool.connect();
  try {
    // load active company tax maps for the company (company_tax_maps)
    const taxMapsRes = await client.query(
      `SELECT id, tenant_id, company_id, country_id, tax_type_id, tax_rate_id, is_default, is_active, account_id, refund_account_id
       FROM public.company_tax_maps
       WHERE company_id = $1 AND is_active = true
       ORDER BY is_default DESC, created_at ASC`,
      [companyId]
    );
    const taxMaps = taxMapsRes.rows;

    // collect ids for prefetch
    const taxRateIds = Array.from(new Set(taxMaps.map((r: any) => r.tax_rate_id).filter(Boolean)));
    const taxTypeIds = Array.from(new Set(taxMaps.map((r: any) => r.tax_type_id).filter(Boolean)));

    // load tax_types
    const taxTypesRes =
      taxTypeIds.length > 0
        ? await client.query(`SELECT id, name, description, metadata FROM public.tax_types WHERE id = ANY($1::uuid[])`, [taxTypeIds])
        : { rows: [] as any[] };
    const taxTypesById = new Map(taxTypesRes.rows.map((r: any) => [r.id, r]));

    // load tax_rates
    const taxRatesRes =
      taxRateIds.length > 0
        ? await client.query(`SELECT id, name, percentage, fixed_amount, country_id, state_id, metadata FROM public.tax_rates WHERE id = ANY($1::uuid[])`, [taxRateIds])
        : { rows: [] as any[] };
    const taxRatesById = new Map(taxRatesRes.rows.map((r: any) => [r.id, r]));

    // fetch company rounding precision (fallback to 2)
    const cs = await client.query(`SELECT rounding_precision FROM public.company_settings WHERE company_id = $1 LIMIT 1`, [companyId]);
    const rounding_precision: number = cs.rows[0]?.rounding_precision ?? 2;

    const results: ResolvedInvoiceLine[] = [];

    for (const line of lines) {
      const qty = toNumber(line.qty ?? 0);
      const unit = toNumber(line.unit_price ?? 0);
      const base = +(qty * unit);

      // candidates: filter taxMaps by country (if map has country and billingCountryId provided)
      const candidates = taxMaps.filter((m: any) => {
        if (m.country_id && billingCountryId && String(m.country_id) !== String(billingCountryId)) return false;
        return m.is_active;
      });

      // determine compound vs non-compound using metadata on tax_types or tax_rates (key: is_compound boolean)
      const nonCompound: any[] = [];
      const compound: any[] = [];
      for (const c of candidates) {
        const tr = taxRatesById.get(c.tax_rate_id);
        const tt = taxTypesById.get(c.tax_type_id);
        const isCompound = Boolean(tt?.metadata?.is_compound || tr?.metadata?.is_compound || false);
        if (isCompound) compound.push(c); else nonCompound.push(c);
      }

      const ordered = [...nonCompound, ...compound];

      let subTotalForCompoundCalc = base;
      const appliedTaxes: ResolvedTaxLine[] = [];

      for (const m of ordered) {
        const tr = taxRatesById.get(m.tax_rate_id);
        const tt = taxTypesById.get(m.tax_type_id);
        if (!tr || !tt) {
          // skip silently but log note in notes field
          appliedTaxes.push({
            tax_type_id: m.tax_type_id,
            tax_type_name: tt?.name,
            tax_rate_id: m.tax_rate_id,
            tax_rate_name: tr?.name,
            rate: 0,
            is_percentage: true,
            is_compound: false,
            base_amount: base,
            tax_amount: 0,
            rounding_applied: 0,
            notes: `missing tax_rate or tax_type definition for map ${m.id}`,
          });
          continue;
        }

        let rate = 0;
        let is_percentage = true;

        if (tr.percentage !== null && tr.percentage !== undefined) {
          rate = Number(tr.percentage);
          is_percentage = true;
        } else if (tr.fixed_amount !== null && tr.fixed_amount !== undefined) {
          rate = Number(tr.fixed_amount);
          is_percentage = false;
        } else {
          rate = 0;
          is_percentage = true;
        }

        const isCompound = Boolean(tt?.metadata?.is_compound || tr?.metadata?.is_compound || false);
        const baseForThis = isCompound ? subTotalForCompoundCalc : base;

        let taxAmount = 0;
        if (is_percentage) {
          taxAmount = +(baseForThis * (rate / 100));
        } else {
          taxAmount = +(rate * qty);
        }

        const rounded = Number(taxAmount.toFixed(rounding_precision));
        appliedTaxes.push({
          tax_type_id: m.tax_type_id,
          tax_type_name: tt?.name,
          tax_rate_id: m.tax_rate_id,
          tax_rate_name: tr?.name,
          rate,
          is_percentage,
          is_compound: isCompound,
          base_amount: base,
          tax_amount: rounded,
          rounding_applied: +(rounded - taxAmount),
          notes: `applied from company_tax_map ${m.id}`,
        });

        subTotalForCompoundCalc = +(subTotalForCompoundCalc + rounded);
      }

      const totalTax = appliedTaxes.reduce((s, t) => s + (t.tax_amount || 0), 0);
      const totalAmount = +(base + totalTax);

      results.push({
        line_id: line.id,
        base_amount: +Number(base.toFixed(rounding_precision)),
        total_tax: +Number(totalTax.toFixed(rounding_precision)),
        total_amount: +Number(totalAmount.toFixed(rounding_precision)),
        taxes: appliedTaxes,
      });
    }

    const subtotal = results.reduce((s, l) => s + l.base_amount, 0);
    const total_tax = results.reduce((s, l) => s + l.total_tax, 0);
    const total = +(subtotal + total_tax);

    return {
      lines: results,
      invoice_totals: {
        subtotal: +Number(subtotal.toFixed(rounding_precision)),
        total_tax: +Number(total_tax.toFixed(rounding_precision)),
        total: +Number(total.toFixed(rounding_precision)),
      },
    };
  } finally {
    client.release();
  }
}
