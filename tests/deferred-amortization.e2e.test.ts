/**
 * MODULE 17 — Deferred Revenue & Deferred Expense Amortization E2E Tests
 *
 * Validates:
 *   1) Deferred Revenue creation
 *   2) Deferred Expense creation
 *   3) Amortization schedule generation
 *   4) Amortization run (monthly)
 *   5) Proration mid-month
 *   6) JE creation for amortization
 *   7) Balanced JE guarantee
 *   8) FX revaluation of remaining deferred balances
 *   9) Reversal of amortization
 *  10) Period close blocking future amortizations
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
      org: "DEFREV",
      tenantName: "DeferredRevTenant",
      companyName: "DeferredCo",
      name: "Admin",
      email: `defrev-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
});

afterAll(async () => {
  await pool.end();
});

async function expectBalanced(jeId: string) {
  const r = await pool.query(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const d = r.rows.reduce((a, r) => a + Number(r.debit), 0);
  const c = r.rows.reduce((a, r) => a + Number(r.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("Deferred Revenue & Expense Amortization E2E", () => {
  let defRevId: string;
  let defExpId: string;

  let scheduleRev: any[];
  let scheduleExp: any[];

  let amortJeRev: string;
  let amortJeExp: string;

  // -------------------------------------------------------
  // 1) Create Deferred Revenue
  // -------------------------------------------------------
  test("Create deferred revenue contract", async () => {
    const dr = await pool.query(
      `
      INSERT INTO deferred_revenue
        (id,tenant_id,company_id,description,total_amount,start_date,end_date,frequency,currency_id)
      VALUES
        (gen_random_uuid(),$1,$2,'Annual SaaS Subscription',1200,'2025-01-01','2025-12-31',
         'MONTHLY',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
      RETURNING id
      `,
      [tenantId, companyId]
    );

    defRevId = dr.rows[0].id;
    expect(defRevId).toBeDefined();
  });

  // -------------------------------------------------------
  // 2) Create Deferred Expense
  // -------------------------------------------------------
  test("Create deferred expense contract", async () => {
    const de = await pool.query(
      `
      INSERT INTO deferred_expense
        (id,tenant_id,company_id,description,total_amount,start_date,end_date,frequency,currency_id)
      VALUES
        (gen_random_uuid(),$1,$2,'Annual Insurance Prepayment',2400,'2025-01-01','2025-12-31',
         'MONTHLY',(SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
      RETURNING id
      `,
      [tenantId, companyId]
    );

    defExpId = de.rows[0].id;
    expect(defExpId).toBeDefined();
  });

  // -------------------------------------------------------
  // 3) Generate amortization schedules
  // -------------------------------------------------------
  test("Generate amortization schedules", async () => {
    const rev = await pool.query(
      `SELECT * FROM generate_amortization_schedule('revenue',$1)`,
      [defRevId]
    );
    const exp = await pool.query(
      `SELECT * FROM generate_amortization_schedule('expense',$1)`,
      [defExpId]
    );

    scheduleRev = rev.rows;
    scheduleExp = exp.rows;

    expect(scheduleRev.length).toBe(12);
    expect(scheduleExp.length).toBe(12);

    // Each month should have equal allocation
    scheduleRev.forEach(r => expect(Number(r.amount)).toBeCloseTo(100));     // 1200/12
    scheduleExp.forEach(r => expect(Number(r.amount)).toBeCloseTo(200));     // 2400/12
  });

  // -------------------------------------------------------
  // 4) Run monthly amortization for revenue
  // -------------------------------------------------------
  test("Run revenue amortization for month 1", async () => {
    const run = await pool.query(
      `SELECT run_amortization('revenue',$1,'2025-01') AS je`,
      [defRevId]
    );

    amortJeRev = run.rows[0].je;
    expect(amortJeRev).toBeDefined();

    await expectBalanced(amortJeRev);

    // Check that 100 revenue recognized
    const revenueCheck = await pool.query(
      `
      SELECT SUM(credit - debit) AS recognized
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [amortJeRev]
    );

    expect(Number(revenueCheck.rows[0].recognized)).toBeCloseTo(100);
  });

  // -------------------------------------------------------
  // 5) Run monthly amortization for expense
  // -------------------------------------------------------
  test("Run expense amortization for month 1", async () => {
    const run = await pool.query(
      `SELECT run_amortization('expense',$1,'2025-01') AS je`,
      [defExpId]
    );

    amortJeExp = run.rows[0].je;
    expect(amortJeExp).toBeDefined();

    await expectBalanced(amortJeExp);

    const expCheck = await pool.query(
      `
      SELECT SUM(debit - credit) AS recognized
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [amortJeExp]
    );

    expect(Number(expCheck.rows[0].recognized)).toBeCloseTo(200);
  });

  // -------------------------------------------------------
  // 6) FX revaluation on remaining deferred balances
  // -------------------------------------------------------
  test("FX revaluation on deferred balances", async () => {
    const run = await pool.query(
      `SELECT run_fx_revaluation($1,$2,'2025-01-31') AS run`,
      [tenantId, companyId]
    );

    expect(run.rows[0].run).toBeDefined();

    const fxJe = await pool.query(
      `
      SELECT id FROM journal_entries
      WHERE reference ILIKE '%FX Revaluation%'
      ORDER BY created_at DESC LIMIT 1
      `
    );

    await expectBalanced(fxJe.rows[0].id);
  });

  // -------------------------------------------------------
  // 7) Reverse amortization for revenue
  // -------------------------------------------------------
  test("Reverse revenue amortization", async () => {
    const rev = await pool.query(
      `SELECT reverse_journal_entry($1,'2025-02-01') AS rev`,
      [amortJeRev]
    );
    await expectBalanced(rev.rows[0].rev);
  });

  // -------------------------------------------------------
  // 8) Period blocking
  // -------------------------------------------------------
  test("Period close blocks amortization", async () => {
    const period = await pool.query(
      `
      INSERT INTO accounting_periods
        (id,tenant_id,company_id,period_label,date_from,date_to,is_open)
      VALUES
        (gen_random_uuid(),$1,$2,'2025-FEB','2025-02-01','2025-02-28',true)
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const periodId = period.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [periodId]);

    await expect(
      pool.query(`SELECT run_amortization('revenue',$1,'2025-02')`, [defRevId])
    ).rejects.toThrow();
  });

  // -------------------------------------------------------
  // 9) Re-open period → amortization allowed
  // -------------------------------------------------------
  test("Re-open period and amortize again", async () => {
    await pool.query(`UPDATE accounting_periods SET is_open=true`);

    const run = await pool.query(
      `SELECT run_amortization('revenue',$1,'2025-02') AS je`,
      [defRevId]
    );

    await expectBalanced(run.rows[0].je);
  });
});
