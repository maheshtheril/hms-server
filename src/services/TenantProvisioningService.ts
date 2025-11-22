import { PoolClient } from "pg";

export class TenantProvisioningService {
  cx: PoolClient;

  constructor(cx: PoolClient) {
    this.cx = cx;
  }

  /* ---------------------------------------------------------
   * Create tenant
   * --------------------------------------------------------- */
  async createTenant(tenantId: string, tenantName: string, slug: string) {
    await this.cx.query(
      `INSERT INTO tenant (id, name, slug, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, tenantName, slug]
    );
  }

  /* ---------------------------------------------------------
   * Create company
   * --------------------------------------------------------- */
  async createCompany(companyId: string, tenantId: string, name: string, countryId: string | null) {
    await this.cx.query(
      `INSERT INTO company (id, tenant_id, name, country_id, enabled, created_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [companyId, tenantId, name, countryId]
    );
  }

  /* ---------------------------------------------------------
   * Create admin user
   * --------------------------------------------------------- */
  async createAdminUser(userId: string, tenantId: string, companyId: string, email: string, name: string, passwordHash: string) {
    await this.cx.query(
      `INSERT INTO app_user 
          (id, tenant_id, company_id, email, name, password, is_admin, is_tenant_admin, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, TRUE, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, tenantId, companyId, email, name, passwordHash]
    );

    // Map user → company
    await this.cx.query(
      `INSERT INTO user_companies (tenant_id, user_id, company_id, is_default, created_at)
       VALUES ($1, $2, $3, TRUE, NOW())
       ON CONFLICT DO NOTHING`,
      [tenantId, userId, companyId]
    );
  }

  /* ---------------------------------------------------------
   * Provision full accounting environment (calls Module 9A SQL)
   * --------------------------------------------------------- */
  async provisionCompanyFinancials(tenantId: string, companyId: string, countryId: string | null) {
    await this.cx.query(`SELECT install_ifrs_coa($1,$2)`, [tenantId, companyId]);
    await this.cx.query(`SELECT install_default_journals($1,$2)`, [tenantId, companyId]);
    await this.cx.query(`SELECT install_default_fiscal_positions($1,$2,$3)`, [
      tenantId,
      companyId,
      countryId,
    ]);
    await this.cx.query(`SELECT install_tax_gl_mappings($1,$2)`, [tenantId, companyId]);
    await this.cx.query(
      `SELECT install_company_accounting_settings($1,$2,$3)`,
      [tenantId, companyId, countryId]
    );
    await this.cx.query(`SELECT install_default_fx($1,$2,$3)`, [
      tenantId,
      companyId,
      countryId,
    ]);
    await this.cx.query(`SELECT install_default_analytic_accounts($1,$2)`, [
      tenantId,
      companyId,
    ]);
  }

  /* ---------------------------------------------------------
   * MASTER PROVISIONING WORKFLOW
   * --------------------------------------------------------- */
  static async run(cx: PoolClient, payload: {
    tenantId: string;
    tenantName: string;
    tenantSlug: string;

    companyId: string;
    companyName: string;
    countryId: string | null;

    userId: string;
    email: string;
    name: string;
    passwordHash: string;
  }) {
    const svc = new TenantProvisioningService(cx);

    await cx.query("BEGIN");

    try {
      await svc.createTenant(payload.tenantId, payload.tenantName, payload.tenantSlug);

      await svc.createCompany(
        payload.companyId,
        payload.tenantId,
        payload.companyName,
        payload.countryId
      );

      await svc.createAdminUser(
        payload.userId,
        payload.tenantId,
        payload.companyId,
        payload.email,
        payload.name,
        payload.passwordHash
      );

      await svc.provisionCompanyFinancials(
        payload.tenantId,
        payload.companyId,
        payload.countryId
      );

      await cx.query("COMMIT");
    } catch (err) {
      await cx.query("ROLLBACK");
      throw err;
    }
  }
}
