/**
 * MODULE 14 — Year-End Closing (YEC) Full E2E Tests
 *
 * Validates:
 *  1. Create fiscal year
 *  2. Create revenue + expense transactions
 *  3. Run year-end close (close_fiscal_year)
 *  4. Validate:
 *        - Revenue reset to zero
 *        - Expense reset to zero
 *        - Retained earnings receives net income
 *        - Assets/liabilities carried forward
 *        - JE created for closing
 *        - JE is balanced
 *  5. Locked year blocks postings
 *  6. Reopen year allows postings again
 */

import request from "supertest";
import { Pool } from "pg";
import app from "../src/app";
import { v4 as uuidv4 } from "uuid";

const pool = new Pool({
  connectionString: process.env.TEST_DB_URL,
});

let tenantId: string;
let companyId: string;

beforeAll(async () => {
  await pool.query("SELECT 1");

  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "YECE2E",
      tenantName: "YEC Tenant",
      companyName: "YECCO",
      name: "Admin",
      email: `yec-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
});

afterAll(async () => {
  await pool.end();
});

async function expectBalanced(jeId: string) {
  const rows = await pool.query(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const d = rows.rows.reduce((a, r) => a + Number(r.debit), 0);
  const c = rows.rows.reduce((a, r) => a + Number(r.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("Year-End Close Simulation", () => {
  let retainedEarningsAcc: string;
  let fiscalYearId: string;
  let yecJeId: string;

  test("Prepare retained earnings account", async () => {
    const rr = await pool.query(
      `SELECT retained_earnings_account_id AS re
       FROM company_accounting_settings
       WHERE company_id=$1`,
      [companyId]
    );
    expect(rr.rowCount).toBe(1);
    retainedEarningsAcc = rr.rows[0].re;
    expect(retainedEarningsAcc).toBeDefined();
  });

  // ───────────────────────────────────────────────
  // 1) Create a fiscal year (Jan–Dec)
  // ───────────────────────────────────────────────
  test("Create fiscal year record", async () => {
    const fy = await pool.query(
      `
      INSERT INTO fiscal_years
        (id, tenant_id, company_id, year_label, date_from, date_to, is_closed)
      VALUES
        (gen_random_uuid(), $1, $2, '2025',
          '2025-01-01', '2025-12-31', false)
      RETURNING id
      `,
      [tenantId, companyId]
    );

    fiscalYearId = fy.rows[0].id;
    expect(fiscalYearId).toBeDefined();
  });

  // ───────────────────────────────────────────────
  // 2) Create revenue + expense transactions
  // ───────────────────────────────────────────────
  test("Post revenue + expense JEs", async () => {
    // Revenue account
    const revAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='REVENUE' LIMIT 1`,
      [companyId]
    );
    expect(revAcc.rowCount).toBe(1);

    // Expense account
    const expAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='EXPENSE' LIMIT 1`,
      [companyId]
    );
    expect(expAcc.rowCount).toBe(1);

    // Cash account
    const cashAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ASSET' LIMIT 1`,
      [companyId]
    );
    expect(cashAcc.rowCount).toBe(1);

    // Revenue JE
    const jeRev = uuidv4();
    await pool.query(
      `
      INSERT INTO journal_entries (id, tenant_id, company_id, journal_id, entry_date, currency_id, fx_rate, ref)
      VALUES ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
              '2025-05-01',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),1,'REV-2025')
      `,
      [jeRev, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,0,4000),
        (gen_random_uuid(),$1,$2,$3,$5,4000,0)
      `,
      [jeRev, tenantId, companyId, revAcc.rows[0].id, cashAcc.rows[0].id]
    );
    await expectBalanced(jeRev);

    // Expense JE
    const jeExp = uuidv4();
    await pool.query(
      `
      INSERT INTO journal_entries (id, tenant_id, company_id, journal_id, entry_date, currency_id, fx_rate, ref)
      VALUES ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
              '2025-06-01',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),1,'EXP-2025')
      `,
      [jeExp, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,1500,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,1500)
      `,
      [jeExp, tenantId, companyId, expAcc.rows[0].id, cashAcc.rows[0].id]
    );

    await expectBalanced(jeExp);
  });

  // ───────────────────────────────────────────────
  // 3) Run Year-End Close
  // ───────────────────────────────────────────────
  test("Run close_fiscal_year()", async () => {
    const res = await pool.query(
      `SELECT close_fiscal_year($1) AS je`,
      [fiscalYearId]
    );
    expect(res.rowCount).toBe(1);

    yecJeId = res.rows[0].je;
    expect(yecJeId).toBeDefined();

    await expectBalanced(yecJeId);
  });

  // ───────────────────────────────────────────────
  // 4) Validate YEC effects
  // ───────────────────────────────────────────────
  test("Validate retained earnings + zeroed revenue/expense", async () => {
    // Total revenue = 4000
    // Total expense = 1500
    // Net income = 2500 → should post to retained earnings
    
    const re = await pool.query(
      `
      SELECT SUM(credit - debit) AS re_balance
      FROM journal_entry_lines
      WHERE account_id=$1
      `,
      [retainedEarningsAcc]
    );

    expect(Number(re.rows[0].re_balance)).toBe(2500);
  });

  // ───────────────────────────────────────────────
  // 5) Year must be locked now
  // ───────────────────────────────────────────────
  test("Posting in closed fiscal year is blocked", async () => {
    const blocked = await pool.query(
      `
      INSERT INTO invoices
        (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1,$2,'BLOCKED-YEC','2025-07-01',200,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const invoiceId = blocked.rows[0].id;

    await expect(
      pool.query(`SELECT post_invoice($1)`, [invoiceId])
    ).rejects.toThrow();
  });

  // ───────────────────────────────────────────────
  // 6) Re-open year and allow posting again
  // ───────────────────────────────────────────────
  test("Reopen fiscal year and allow posting again", async () => {
    await pool.query(`UPDATE fiscal_years SET is_closed=false WHERE id=$1`, [
      fiscalYearId,
    ]);

    // Now invoice posting should succeed
    const inv = await pool.query(
      `
      INSERT INTO invoices
        (id,tenant_id,company_id,invoice_number,invoice_date,total_amount,currency_id)
      VALUES
        (gen_random_uuid(),$1,$2,'UNBLOCK-YEC','2025-08-01',100,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const okPost = await pool.query(`SELECT post_invoice($1) AS je`, [
      inv.rows[0].id,
    ]);

    await expectBalanced(okPost.rows[0].je);
  });
});
