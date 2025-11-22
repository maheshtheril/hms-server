/**
 * MODULE 11B — Full E2E Vendor Bill Posting Test Suite
 * Tests:
 *  - Vendor bill creation
 *  - Line items
 *  - Taxes
 *  - Analytic accounting
 *  - Posting vendor bill (Module 8B)
 *  - Journal entry verification
 */

import request from "supertest";
import { Pool } from "pg";
import app from "../src/app";

const pool = new Pool({
  connectionString: process.env.TEST_DB_URL,
});

let tenantId: string;
let companyId: string;
let userId: string;

beforeAll(async () => {
  await pool.query("SELECT 1");

  // bootstrap tenant using signup route (Module 10)
  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "VendorBillOrg",
      tenantName: "Vendor Bill Org",
      companyName: "Vendor Bill Co",
      name: "Admin User",
      email: `vb-${Date.now()}@example.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
  userId = signup.body.userId;

  expect(tenantId).toBeDefined();
  expect(companyId).toBeDefined();
  expect(userId).toBeDefined();
});

afterAll(async () => {
  await pool.end();
});

describe("E2E — Vendor Bill Posting Flow", () => {
  let billId: string;
  let taxRateId: string;

  test("prepare tax rate", async () => {
    const tr = await pool.query(
      `SELECT id FROM tax_rates ORDER BY rate_value DESC LIMIT 1`
    );
    expect(tr.rowCount).toBe(1);
    taxRateId = tr.rows[0].id;
  });

  test("create vendor bill", async () => {
    const result = await pool.query(
      `
      INSERT INTO vendor_bill
        (id, tenant_id, company_id, vendor_id, bill_number, bill_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), 'BILL-001', NOW(), 1000, 
          (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    expect(result.rowCount).toBe(1);
    billId = result.rows[0].id;
  });

  test("add line items", async () => {
    const res = await pool.query(
      `
      INSERT INTO vendor_bill_items
        (id, bill_id, tenant_id, company_id, description, amount, analytic_account_id)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'Medical Supplies', 800,
          (SELECT id FROM analytic_accounts WHERE company_id=$3 LIMIT 1)
        ),
        (gen_random_uuid(), $1, $2, $3, 'Laboratory Chemicals', 200,
          (SELECT id FROM analytic_accounts WHERE company_id=$3 LIMIT 1)
        );
    `,
      [billId, tenantId, companyId]
    );

    expect(res.rowCount).toBeGreaterThanOrEqual(1);
  });

  test("add taxes", async () => {
    const res = await pool.query(
      `
      INSERT INTO vendor_bill_taxes
        (id, tenant_id, company_id, bill_id, tax_rate_id, tax_amount)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, 180);
    `,
      [tenantId, companyId, billId, taxRateId]
    );

    expect(res.rowCount).toBe(1);
  });

  test("post vendor bill through posting engine (Module 8B)", async () => {
    const result = await pool.query(
      `SELECT post_vendor_bill($1) AS je;`,
      [billId]
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].je).toBeDefined();
  });

  test("verify journal entry created", async () => {
    const je = await pool.query(
      `
      SELECT journal_entry_id
      FROM vendor_bill
      WHERE id=$1
    `,
      [billId]
    );

    expect(je.rowCount).toBe(1);
    const journalEntryId = je.rows[0].journal_entry_id;
    expect(journalEntryId).toBeTruthy();

    // fetch lines
    const lines = await pool.query(
      `
      SELECT account_id, debit, credit, analytic_account_id, is_tax_line
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
    `,
      [journalEntryId]
    );

    expect(lines.rowCount).toBeGreaterThanOrEqual(3);

    // 1) Expense lines
    const expenseLines = lines.rows.filter((r) => r.debit > 0 && r.is_tax_line === false);
    expect(expenseLines.length).toBe(2);

    // 2) Tax Line
    const taxLines = lines.rows.filter((r) => r.is_tax_line === true);
    expect(taxLines.length).toBe(1);

    // 3) AP Line
    const apLines = lines.rows.filter((r) => r.credit > 0 && r.is_tax_line === false);
    expect(apLines.length).toBeGreaterThanOrEqual(1);

    // 4) Double entry check
    const totalDebit = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((a, r) => a + Number(r.credit), 0);

    expect(Number(totalDebit.toFixed(2))).toBe(Number(totalCredit.toFixed(2)));

    // 5) Analytic accounts
    const analytics = lines.rows.filter((r) => r.analytic_account_id !== null);
    expect(analytics.length).toBeGreaterThanOrEqual(2);
  });
});
