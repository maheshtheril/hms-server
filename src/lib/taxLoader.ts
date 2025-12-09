// server/src/lib/taxLoader.ts
import { PoolClient } from "pg";

export type CompanyTaxMapRow = {
  id: string;
  tenant_id: string;
  company_id: string;
  country_id: string | null;
  tax_type_id: string;
  tax_rate_id: string | null;
  is_default: boolean;
  created_at: string | null;
};

/**
 * Return existing company tax maps (ordered).
 */
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
 * Robust loader:
 * - If company already has maps -> return them (idempotent)
 * - Prefer country_tax_mappings for a given countryId
 * - Else for each active tax_type, pick the first active tax_rate (lowest rate)
 * - Insert into company_tax_maps (ignore duplicate key errors)
 * - Optionally set company_settings defaults to first inserted mapping
 */
export async function loadCompanyTaxesFromCountry(
  client: PoolClient,
  tenantId: string,
  companyId: string,
  countryId: string | null,
  opts?: { setDefaults?: boolean }
): Promise<CompanyTaxMapRow[]> {
  // 1) idempotent check
  const existing = await getCompanyTaxMaps(client, companyId);
  if (existing.length > 0) {
    console.debug("[taxLoader] existing company_tax_maps found, skipping loader", { companyId, count: existing.length });
    return existing;
  }

  // 2) collect tax types + one rate each (prefer country mappings if available)
  const candidates: Array<{ tax_type_id: string; tax_rate_id: string | null }> = [];

  try {
    // Try country-specific mappings first (if countryId provided)
    if (countryId) {
      try {
        const rc = await client.query(
          `
          SELECT ctm.tax_type_id, ctm.tax_rate_id
          FROM country_tax_mappings ctm
          WHERE ctm.country_id = $1 AND ctm.is_active = TRUE
          ORDER BY ctm.created_at
          LIMIT 200
          `,
          [countryId]
        );

        for (const row of rc.rows) {
          if (row.tax_type_id) {
            candidates.push({ tax_type_id: row.tax_type_id, tax_rate_id: row.tax_rate_id || null });
          }
        }

        console.debug("[taxLoader] found country_tax_mappings candidates", {
          countryId,
          candidateCount: rc.rowCount,
        });
      } catch (countryErr) {
        // Log and fall back to global approach
        console.warn("[taxLoader] failed to read country_tax_mappings; falling back to global rates", {
          countryId,
          err: countryErr && (countryErr.stack || countryErr.message || countryErr),
        });
      }
    }

    // Fallback: global tax_types + lowest active tax_rate per type
    if (candidates.length === 0) {
      const r = await client.query(
        `
        SELECT tt.id AS tax_type_id,
               (SELECT id FROM tax_rates tr
                  WHERE tr.tax_type_id = tt.id
                    AND (tr.is_active IS TRUE OR tr.is_active IS NULL)
                  ORDER BY tr.rate ASC
                  LIMIT 1) AS tax_rate_id
        FROM tax_types tt
        WHERE (tt.is_active IS TRUE OR tt.is_active IS NULL)
        ORDER BY tt.name
        LIMIT 200
      `
      );

      for (const row of r.rows) {
        if (row.tax_type_id) {
          candidates.push({ tax_type_id: row.tax_type_id, tax_rate_id: row.tax_rate_id || null });
        }
      }

      console.debug("[taxLoader] found global tax_type->tax_rate candidates", { candidateCount: r.rowCount });
    }
  } catch (err) {
    console.error("[taxLoader] failed to fetch tax types/tax rates or country mappings:", err && (err.stack || err.message || err));
    // If this fails for unexpected reasons, return empty (do not throw).
    return [];
  }

  if (candidates.length === 0) {
    console.info("[taxLoader] no candidates found (no tax_types or no active rates). nothing to insert.");
    return [];
  }

  // 3) filter out null rates and dedupe by tax_type_id
  const seen = new Set<string>();
  const dedup: Array<{ tax_type_id: string; tax_rate_id: string | null }> = [];
  for (const c of candidates) {
    if (!c.tax_type_id) continue;
    if (c.tax_rate_id === null) {
      // skip types without a rate (avoid NOT NULL or FK fails)
      console.debug("[taxLoader] skipping tax_type due to NULL tax_rate_id", { tax_type_id: c.tax_type_id });
      continue;
    }
    if (seen.has(c.tax_type_id)) continue;
    seen.add(c.tax_type_id);
    dedup.push(c);
  }

  if (dedup.length === 0) {
    console.info("[taxLoader] candidates present but all had null rates or duplicates — nothing to insert.");
    return [];
  }

  console.info("[taxLoader] candidates to insert (deduped)", JSON.stringify(dedup));

  // 4) insert candidates (best-effort)
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
        [tenantId, companyId, countryId || null, cand.tax_type_id, cand.tax_rate_id, i === 0]
      );
      if (res.rowCount > 0) {
        inserted.push(res.rows[0]);
        console.info("[taxLoader] inserted company_tax_map", { companyId, tax_type_id: cand.tax_type_id, tax_rate_id: cand.tax_rate_id, is_default: i === 0 });
      }
    } catch (err: any) {
      // Unique constraint or FK issues may happen; log and continue.
      // include err.code when available for quick triage
      console.warn(
        "[taxLoader] insert company_tax_maps skipped/failed",
        {
          tax_type_id: cand.tax_type_id,
          tax_rate_id: cand.tax_rate_id,
          err_message: err && (err.message || err),
          err_code: err && err.code,
        }
      );
      // continue with others
    }
  }

  // 5) Optionally set defaults in company_settings (only if inserted something)
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
      console.info("[taxLoader] company_settings defaults set (if previously null)", { companyId, default_tax_type_id: first.tax_type_id, default_tax_rate_id: first.tax_rate_id });
    } catch (err) {
      console.warn("[taxLoader] failed to set company_settings defaults:", err && (err.message || err));
    }
  }

  // 6) return final list
  return await getCompanyTaxMaps(client, companyId);
}

export default { getCompanyTaxMaps, loadCompanyTaxesFromCountry };
