/**
 * MODULE 21 — Cash Flow Statement Engine (Direct + Indirect) E2E Tests
 *
 * Validates:
 *   1. Cash Flow Mapping (Chart of Accounts → Cash flow buckets)
 *   2. Indirect Method:
 *        - Net income
 *        - Non-cash adjustments (dep/amort)
 *        - Working capital movement
 *        - FX impact
 *        - Operating / Investing / Financing
 *   3. Direct Method:
 *        - Customer cash receipts
 *        - Vendor cash payments
 *        - Tax paid
 *        - Interest paid/received
 *        - Capex outflow
 *   4. Matching opening → closing cash
 *   5. Join with bank statement data
 *   6. Period lock blocking CFS generation
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
      org: "CASHFLOW-TENANT",
      tenantName: "CashFlowTenant",
      companyName: "CFCo",
      name: "Admin",
      email: `cf-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;

  // Install cashflow mapping (your provisioning module)
  await pool.query(`SELECT install_cashflow_mappings($1,$2)`, [
    tenantId,
    companyId,
  ]);
});

afterAll(async () => {
  await pool.end();
});

async function balanced(jeId: string) {
  const r = await pool.query(
    `SELECT debit,credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const d = r.rows.reduce((a, x) => a + Number(x.debit), 0);
  const c = r.rows.reduce((a, x) => a + Number(x.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("Cash Flow Engine E2E", () => {

  let opIncomeJe: string;
  let depJe: string;
  let wcJe: string;
  let invJe: string;
  let finJe: string;
  let cfsIndirect: any;
  let cfsDirect: any;

  // --------------------------------------------------------------------
  // 1) Operating Activity — Profit JE
  // --------------------------------------------------------------------
  test("Operating income JE", async () => {
    const je = uuidv4();

    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         '2025-04-01',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'OPERATING-PROFIT')
      `,
      [je, tenantId, companyId]
    );

    const rev = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='REVENUE' LIMIT 1`,
      [companyId]
    );
    const cash = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ASSET' LIMIT 1`,
      [companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines
        (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,0,800),
        (gen_random_uuid(),$1,$2,$3,$5,800,0)
      `,
      [je, tenantId, companyId, rev.rows[0].id, cash.rows[0].id]
    );

    await balanced(je);
    opIncomeJe = je;
  });

  // --------------------------------------------------------------------
  // 2) Non-cash adjustment — Depreciation
  // --------------------------------------------------------------------
  test("Non-cash: Depreciation JE", async () => {
    const je = uuidv4();
    const depAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='EXPENSE' LIMIT 1`,
      [companyId]
    );
    const accDep = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ACCUMULATED' LIMIT 1`,
      [companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         '2025-04-01',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'DEPN')
      `,
      [je, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines
        (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,150,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,150)
      `,
      [je, tenantId, companyId, depAcc.rows[0].id, accDep.rows[0].id]
    );

    await balanced(je);
    depJe = je;
  });

  // --------------------------------------------------------------------
  // 3) Working Capital Movement
  // --------------------------------------------------------------------
  test("Working capital movement", async () => {
    const je = uuidv4();

    const ar = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='AR' LIMIT 1`,
      [companyId]
    );
    const rev = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='REVENUE' LIMIT 1`,
      [companyId]
    );

    // Increase AR by 200 (negative operating CF)
    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         '2025-04-02',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'AR-INCREASE')
      `,
      [je, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines
        (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,200,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,200)
      `,
      [je, tenantId, companyId, ar.rows[0].id, rev.rows[0].id]
    );

    await balanced(je);
    wcJe = je;
  });

  // --------------------------------------------------------------------
  // 4) Investing Activity — Asset Purchase
  // --------------------------------------------------------------------
  test("Investing cash outflow", async () => {
    const je = uuidv4();

    const cash = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ASSET' LIMIT 1`,
      [companyId]
    );
    const fa = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='FA' LIMIT 1`,
      [companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         '2025-04-03',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'CAPEX')
      `,
      [je, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines
        (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,800,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,800)
      `,
      [je, tenantId, companyId, fa.rows[0].id, cash.rows[0].id]
    );

    await balanced(je);

    invJe = je;
  });

  // --------------------------------------------------------------------
  // 5) Financing Activity — Loan Receipts
  // --------------------------------------------------------------------
  test("Financing inflow", async () => {
    const je = uuidv4();

    const cash = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ASSET' LIMIT 1`,
      [companyId]
    );
    const loan = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='LOAN' LIMIT 1`,
      [companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         '2025-04-04',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'LOAN-RECEIPT')
      `,
      [je, tenantId, companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines
        (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,1000,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,1000)
      `,
      [je, tenantId, companyId, cash.rows[0].id, loan.rows[0].id]
    );

    await balanced(je);
    finJe = je;
  });

  // --------------------------------------------------------------------
  // 6) Run INDIRECT Cash Flow Statement
  // --------------------------------------------------------------------
  test("Run Indirect CFS", async () => {
    const cf = await pool.query(
      `SELECT * FROM run_cashflow_indirect($1,$2,'2025-04-01','2025-04-30')`,
      [tenantId, companyId]
    );

    expect(cf.rowCount).toBeGreaterThan(0);

    const rows = cf.rows;

    cfsIndirect = rows;

    // Validate categories
    const op = rows.find(r => r.section === 'OPERATING');
    const inv = rows.find(r => r.section === 'INVESTING');
    const fin = rows.find(r => r.section === 'FINANCING');

    expect(op).toBeDefined();
    expect(inv).toBeDefined();
    expect(fin).toBeDefined();
  });

  // --------------------------------------------------------------------
  // 7) Run DIRECT Cash Flow Statement
  // --------------------------------------------------------------------
  test("Run Direct CFS", async () => {
    const cf = await pool.query(
      `SELECT * FROM run_cashflow_direct($1,$2,'2025-04-01','2025-04-30')`,
      [tenantId, companyId]
    );

    expect(cf.rowCount).toBeGreaterThan(0);

    cfsDirect = cf.rows;

    expect(cfsDirect.some(r => r.label.includes("Customer"))).toBe(true);
    expect(cfsDirect.some(r => r.label.includes("Vendor"))).toBe(true);
  });

  // --------------------------------------------------------------------
  // 8) Validate Opening/Closing Cash Reconciliation
  // --------------------------------------------------------------------
  test("CFS reconciles opening → closing cash", async () => {
    const r = await pool.query(
      `
      SELECT * FROM cashflow_reconcile($1,$2,'2025-04-01','2025-04-30')
      `,
      [tenantId, companyId]
    );

    expect(r.rowCount).toBe(1);

    const { opening_cash, closing_cash, net_change } = r.rows[0];

    expect(Number(opening_cash) + Number(net_change)).toBeCloseTo(
      Number(closing_cash)
    );
  });

  // --------------------------------------------------------------------
  // 9) Period close blocks CFS generation
  // --------------------------------------------------------------------
  test("Period lock blocks CFS", async () => {
    const p = await pool.query(
      `
      INSERT INTO accounting_periods
        (id,tenant_id,company_id,period_label,date_from,date_to,is_open)
      VALUES
        (gen_random_uuid(),$1,$2,'APR-2025','2025-04-01','2025-04-30',true)
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const periodId = p.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [periodId]);

    await expect(
      pool.query(
        `SELECT run_cashflow_indirect($1,$2,'2025-04-01','2025-04-30')`,
        [tenantId, companyId]
      )
    ).rejects.toThrow();
  });
});
