/**
 * Module 10 — Full E2E Test Suite for ERP Tenant Signup
 * Requires:
 *  - Jest
 *  - Supertest
 *  - Express app (exported)
 *  - A clean test DB (recommended)
 */

import request from "supertest";
import { Pool } from "pg";
import app from "../src/app";

const pool = new Pool({
  connectionString: process.env.TEST_DB_URL,
});

beforeAll(async () => {
  // Ensure DB is reachable
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("E2E SIGNUP + FULL PROVISIONING", () => {
  test("creates tenant, company, user, RBAC, accounting, taxes, journals", async () => {
    const payload = {
      org: "TestOrg",
      tenantName: "Test Tenant",
      companyName: "Main Company",
      name: "Admin User",
      email: "admin+" + Date.now() + "@example.com",
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111", // mock
      apply_country_tax_defaults: true,
    };

    // === 1) Call API ===
    const res = await request(app)
      .post("/tenant-signup")
      .send(payload)
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBeDefined();
    expect(res.body.companyId).toBeDefined();
    expect(res.body.userId).toBeDefined();

    const tenantId = res.body.tenantId;
    const companyId = res.body.companyId;
    const userId = res.body.userId;

    // === 2) Verify tenant ===
    const tenantCheck = await pool.query(
      `SELECT id FROM tenant WHERE id=$1`,
      [tenantId]
    );
    expect(tenantCheck.rowCount).toBe(1);

    // === 3) Verify company ===
    const companyCheck = await pool.query(
      `SELECT id, tenant_id FROM company WHERE id=$1`,
      [companyId]
    );
    expect(companyCheck.rowCount).toBe(1);
    expect(companyCheck.rows[0].tenant_id).toBe(tenantId);

    // === 4) Verify admin user ===
    const userCheck = await pool.query(
      `SELECT id, tenant_id, email, is_admin FROM app_user WHERE id=$1`,
      [userId]
    );
    expect(userCheck.rowCount).toBe(1);
    expect(userCheck.rows[0].tenant_id).toBe(tenantId);
    expect(userCheck.rows[0].is_admin).toBe(true);

    // === 5) Verify user_companies mapping ===
    const uc = await pool.query(
      `SELECT company_id FROM user_companies WHERE user_id=$1`,
      [userId]
    );
    expect(uc.rowCount).toBe(1);
    expect(uc.rows[0].company_id).toBe(companyId);

    // === 6) Verify accounting provisioning ===
    const coa = await pool.query(
      `SELECT COUNT(*) AS c FROM account_chart WHERE company_id=$1`,
      [companyId]
    );
    expect(Number(coa.rows[0].c)).toBeGreaterThanOrEqual(20);

    const journals = await pool.query(
      `SELECT COUNT(*) AS c FROM journals WHERE company_id=$1`,
      [companyId]
    );
    expect(Number(journals.rows[0].c)).toBeGreaterThanOrEqual(5);

    const fiscalPositions = await pool.query(
      `SELECT COUNT(*) AS c FROM fiscal_positions WHERE company_id=$1`,
      [companyId]
    );
    expect(Number(fiscalPositions.rows[0].c)).toBeGreaterThanOrEqual(3);

    const analyticAccounts = await pool.query(
      `SELECT COUNT(*) AS c FROM analytic_accounts WHERE company_id=$1`,
      [companyId]
    );
    expect(Number(analyticAccounts.rows[0].c)).toBeGreaterThanOrEqual(4);

    const settings = await pool.query(
      `SELECT id FROM company_accounting_settings WHERE company_id=$1`,
      [companyId]
    );
    expect(settings.rowCount).toBe(1);

    // === 7) Verify tax GL mapping ===
    const taxGL = await pool.query(
      `SELECT COUNT(*) AS c FROM tax_gl_accounts WHERE company_id=$1`,
      [companyId]
    );
    expect(Number(taxGL.rows[0].c)).toBeGreaterThan(0);

    // === 8) Verify RBAC Provisioning (admin role)
    const rbac = await pool.query(
      `SELECT role_id FROM user_roles WHERE user_id=$1`,
      [userId]
    );
    expect(rbac.rowCount).toBeGreaterThanOrEqual(1);

    // === 9) Verify session cookie was issued ===
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  test("prevents duplicate email", async () => {
    const email = "dupe+" + Date.now() + "@example.com";

    const payload = {
      org: "OrgA",
      companyName: "Comp",
      name: "User",
      email,
      password: "SuperStrong#1234",
    };

    // first signup
    await request(app).post("/tenant-signup").send(payload).expect(201);

    // second signup → conflict
    const res2 = await request(app).post("/tenant-signup").send(payload);
    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe("email_exists");
  });

  test("rejects weak password", async () => {
    const res = await request(app)
      .post("/tenant-signup")
      .send({
        org: "WeakCo",
        name: "Weak User",
        email: "weak@example.com",
        password: "123",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("weak_password");
  });

  test("rejects invalid email", async () => {
    const res = await request(app)
      .post("/tenant-signup")
      .send({
        org: "Invalid Email Org",
        name: "User",
        email: "not-an-email",
        password: "SuperStrong#1234",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_email");
  });
});
