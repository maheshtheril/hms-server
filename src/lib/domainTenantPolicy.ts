// server/src/lib/domainTenantPolicy.ts
import { pool } from "../db";

/**
 * domainTenantPolicy(email)
 *
 * Matches the domain_policies DDL you provided:
 *   columns: id, domain, tenant_id, allow_all, created_at
 *
 * Return shapes:
 *  - { ok: true, mode: "allow_new" }
 *  - { ok: true, mode: "join_existing", tenantId }
 *  - { ok: false, status, error }
 *
 * Behavior:
 *  1) If domain_policies row exists:
 *     - if tenant_id present -> join_existing(tenant_id)
 *     - else if allow_all true -> allow_new
 *     - else -> allow_new (default; adjust if you want blocking)
 *  2) If no domain_policies row, look for existing app_user with same domain -> join_existing
 *  3) Default -> allow_new
 *  4) Fail-open on DB errors
 */

export type DomainPolicyResult =
  | { ok: true; mode: "allow_new"; tenantId?: null }
  | { ok: true; mode: "join_existing"; tenantId: string }
  | { ok: false; status: number; error: string };

export default async function domainTenantPolicy(email: string): Promise<DomainPolicyResult> {
  if (typeof email !== "string" || !email.includes("@")) {
    return { ok: false, status: 400, error: "invalid_email" };
  }

  const domain = email.split("@")[1].toLowerCase().trim();
  if (!domain) return { ok: true, mode: "allow_new", tenantId: null };

  try {
    // Check if domain_policies table exists (avoid exceptions if not present)
    const tbl = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'domain_policies' LIMIT 1`
    );

    if (tbl.rowCount > 0) {
      // Query using lower(domain) to use the indexed lower(domain) index
      const policyQ = await pool.query(
        `SELECT tenant_id, allow_all FROM domain_policies WHERE lower(domain) = $1 LIMIT 1`,
        [domain]
      );

      if (policyQ.rowCount > 0) {
        const row = policyQ.rows[0];

        // If tenant_id is provided, prefer join_existing
        if (row.tenant_id) {
          return { ok: true, mode: "join_existing", tenantId: row.tenant_id };
        }

        // If allow_all is true, allow new tenant creation
        if (row.allow_all === true) {
          return { ok: true, mode: "allow_new", tenantId: null };
        }

        // You may want to change this default behavior to block or require approval.
        // For now, default to allow_new when domain_policies row exists but neither tenant_id nor allow_all is set.
        return { ok: true, mode: "allow_new", tenantId: null };
      }
    }

    // No explicit policy — look for any existing app_user with this domain and return join_existing if found.
    // Use LOWER(email) LIKE '%@domain' to be index-friendly if you have an index on LOWER(email).
    const pattern = `%@${domain}`;
    const existing = await pool.query(
      `SELECT tenant_id FROM app_user WHERE LOWER(email) LIKE $1 LIMIT 1`,
      [pattern.toLowerCase()]
    );

    if (existing.rowCount > 0) {
      const tenantId = existing.rows[0].tenant_id;
      if (tenantId) return { ok: true, mode: "join_existing", tenantId };
    }

    // Default allow
    return { ok: true, mode: "allow_new", tenantId: null };
  } catch (err) {
    console.error("[domainTenantPolicy] error (failing open):", err);
    // Fail-open: allow signups if policy check fails
    return { ok: true, mode: "allow_new", tenantId: null };
  }
}
