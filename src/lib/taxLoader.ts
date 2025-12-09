// server/src/lib/taxLoader.ts
import { PoolClient } from "pg";

/**
 * Loader adapted to your schema:
 * - inserts into company_tax_maps (tenant_id, company_id, country_id, tax_type_id, tax_rate_id)
 * - is idempotent: if company_tax_maps rows exist for the company, returns them unchanged
 * - sets company_settings.default_tax_type_id/default_tax_rate_id if empty (first mapping)
 */

export type CompanyTaxMapRow = {
  id: string;
  tenant_id: string;
  company_id: string;
  country_id: string | null;
  tax_type_id: string;
  tax_rate_id: string;
  is_default: boolean;
  created_at: string | null;
};

export async function getCompanyTaxMaps(client: PoolClient, companyId: string): Promise<CompanyTaxMapRow[]> {
  const q = `
    SELECT ctm.id, ctm.tenant_id, ctm.company_id, ctm.country_id,
           ctm.tax_type_id, ctm.tax_rate_id, ctm.is_default, ctm.created_at
    FROM company_tax_maps ctm
    WHERE ctm.company_id = $1
    ORDER BY ctm.created_at ASC
  `;
  const r = await client.query(q, [companyId]);
  return r.rows;
}

/**
 * Load company tax maps from country-level/global tax tables.
 * - client: PoolClient (use same connection/tx as signup)
 * - tenantId: tenant UUID (used when inserting company_tax_maps)
 * - companyId: company UUID
 * - countryId: address_country_id from company_settings
 * - opts.setDefaults: if true, attempt to populate company_settings.default_tax_type_id / default_tax_rate_id
 */
export async function loadCompanyTaxesFromCountry(
  client: PoolClient,
  tenantId: string,
  companyId: string,
  countryId: string,
  opts?: { setDefaults?: boolean }
): Promise<CompanyTaxMapRow[]> {
  // 1) if company already has maps, return them (idempotent)
  const existing = await getCompanyTaxMaps(client, companyId);
  if (existing.length > 0) return existing;

  // 2) collect candidate tax_type_id/tax_rate_id pairs
  const candidates: Array<{ tax_type_id: string; tax_rate_id: string | null }> = [];

  // Strategy A: tax_rates that link to tax_types — prefer those where tax_rates/tax_types mention the country (if your schema has country_id on them)
  try {
    const r = await client.query(
      `
      SELECT tt.id AS tax_type_id, tr.id AS tax_rate_id
      FROM tax_types tt
      LEFT JOIN tax_rates tr ON tr.tax_type_id = tt.id
      WHERE (tt.is_active IS TRUE OR tt.is_active IS NULL)
        AND (tr.is_active IS TRUE OR tr.is_active IS NULL)
        AND (tr.country_id = $1 OR tt.country_id = $1)
      ORDER BY tt.name, tr.rate
      LIMIT 20
    `,
      [countryId]
    );
    if (r.rowCount > 0) {
      for (const row of r.rows) candidates.push({ tax_type_id: row.tax_type_id, tax_rate_id: row.tax_rate_id || null });
    }
  } catch (err) {
    // If columns like country_id don't exist on tax_rates/tax_types, query will error — ignore and continue
    // console.warn("[taxLoader] strategyA failed:", err?.message || err);
  }

  // Strategy B: if nothing found, try any tax_types + their first active rate
  if (candidates.length === 0) {
    const r2 = await client.query(
      `
      SELECT tt.id AS tax_type_id, tr.id AS tax_rate_id
      FROM tax_types tt
      LEFT JOIN LATERAL (
        SELECT id FROM tax_rates tr2
        WHERE tr2.tax_type_id = tt.id AND (tr2.is_active IS TRUE OR tr2.is_active IS NULL)
        ORDER BY tr2.rate LIMIT 1
      ) tr ON true
      WHERE (tt.is_active IS TRUE OR tt.is_active IS NULL)
      ORDER BY tt.name
      LIMIT 10
    `
    );
    for (const row of r2.rows) {
      candidates.push({ tax_type_id: row.tax_type_id, tax_rate_id: row.tax_rate_id || null });
    }
  }

  if (candidates.length === 0) return [];

  // Deduplicate by tax_type_id
  const seen = new Set<string>();
  const dedup = candidates.filter((c) => {
    if (!c.tax_type_id) return false;
    if (seen.has(c.tax_type_id)) return false;
    seen.add(c.tax_type_id);
    return true;
  });

  const inserted: CompanyTaxMapRow[] = [];
  for (let i = 0; i < dedup.length; i++) {
    const cand = dedup[i];
    try {
      const res = await client.query(
        `
        INSERT INTO company_tax_maps
          (id, tenant_id, company_id, country_id, tax_type_id, tax_rate_id, is_default, is_active, created_at, updated_at)
        VALUES
          (gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, now(), now())
        RETURNING id, tenant_id, company_id, country_id, tax_type_id, tax_rate_id, is_default, created_at
      `,
        [tenantId, companyId, countryId || null, cand.tax_type_id, cand.tax_rate_id || cand.tax_rate_id, i === 0] // mark first inserted as default
      );
      if (res.rowCount > 0) {
        inserted.push(res.rows[0]);
      }
    } catch (err) {
      console.error("[taxLoader] insert company_tax_maps failed:", err?.message || err);
      // continue with other inserts
    }
  }

  // Optionally set company_settings defaults (if not already set)
  if (opts?.setDefaults && inserted.length > 0) {
    try {
      const first = inserted[0];
      await client.query(
        `
        UPDATE company_settings
        SET default_tax_type_id = COALESCE(default_tax_type_id, $1),
            default_tax_rate_id = COALESCE(default_tax_rate_id, $2),
            updated_at = now()
        WHERE company_id = $3
      `,
        [first.tax_type_id, first.tax_rate_id || null, companyId]
      );
    } catch (err) {
      console.error("[taxLoader] setting company_settings defaults failed:", err?.message || err);
    }
  }

  // return the inserted rows (or any now-existing maps)
  return await getCompanyTaxMaps(client, companyId);
}

export default { getCompanyTaxMaps, loadCompanyTaxesFromCountry };
