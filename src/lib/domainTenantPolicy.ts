// server/src/lib/domainTenantPolicy.ts
import { pool } from "../db";

/**
 * domainTenantPolicy(email)
 *
 * Determines how to handle signups for a given email domain.
 *
 * Return shape:
 *  - { ok: true, mode: "allow_new" }                -> allow creating a new tenant
 *  - { ok: true, mode: "join_existing", tenantId } -> auto-join an existing tenant
 *  - { ok: false, status: number, error: string }  -> block or require special handling
 *
 * Modes supported:
 *  - allow_new         : create a new tenant (default)
 *  - join_existing     : auto-join the tenant that already uses that email domain
 *  - block_duplicate   : block creation (409)
 *  - require_admin_approval : block, require invite/approval (403)
 *  - require_sso       : block, require SSO (403)
 *
 * Implementation notes:
 *  - Looks for an optional `domain_policies` table first (per-domain overrides).
 *  - If no explicit policy, checks app_user table for an existing domain and returns join_existing by default.
 *  - Fail-open on DB errors (does not block signups) — logs the error and allows creation.
 */

export type DomainPolicyResult =
  | { ok: true; mode: "allow_new"; tenantId?: null }
  | { ok: true; mode: "join_existing"; tenantId: string }
  | { ok: false; status: number; error: string };

export default async function domainTenantPolicy(email: string): Promise<DomainPolicyResult> {
  if (typeof email !== "string" || !email.includes("@")) {
    return { ok: false, status: 400, error: "invalid_email" };
  }

  const domain = email.split("@")[1].toLowerCase();

  try {
    // 1) Check domain_policies table if exists (optional per-domain overrides)
    const policyCheck = await pool.query(
      `SELECT mode, tenant_id FROM domain_policies WHERE domain = $1 LIMIT 1`,
      [domain]
    );

    if (policyCheck.rowCount > 0) {
      const { mode, tenant_id } = policyCheck.rows[0];
      switch (mode) {
        case "join_existing":
          return { ok: true, mode: "join_existing", tenantId: tenant_id };
        case "block_duplicate":
          return { ok: false, status: 409, error: "domain_exists_blocked" };
        case "require_admin_approval":
          return { ok: false, status: 403, error: "admin_approval_required" };
        case "require_sso":
          return { ok: false, status: 403, error: "sso_required" };
        case "allow_new":
        default:
          return { ok: true, mode: "allow_new", tenantId: null };
      }
    }

    // 2) If no explicit policy, look for existing users with same domain
    const existing = await pool.query(
      `SELECT tenant_id FROM app_user WHERE email ILIKE $1 LIMIT 1`,
      [`%@${domain}`]
    );

    if (existing.rowCount > 0) {
      const tenantId = existing.rows[0].tenant_id;
      if (tenantId) return { ok: true, mode: "join_existing", tenantId };
      // if tenant_id missing for some reason, fall through to allow_new
    }

    // 3) Default: allow creating a new tenant
    return { ok: true, mode: "allow_new", tenantId: null };
  } catch (err) {
    console.error("[domainTenantPolicy] error:", err);
    // Fail-open to avoid blocking signups due to policy check failures
    return { ok: true, mode: "allow_new", tenantId: null };
  }
}
