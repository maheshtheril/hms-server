/**
 * MODULE 19 — Budgeting + Commitment Control (Encumbrance Accounting) E2E
 *
 * Validates:
 *   1) Budget creation + approval
 *   2) Pre-encumbrance on purchase request
 *   3) Encumbrance on Purchase Order
 *   4) Expense on Vendor Bill consumes budget
 *   5) Budget availability control blocks overspending
 *   6) Encumbrance reversal when PO cancelled/closed
 *   7) Budget revision & supplemental budget
 *   8) Year-end carry-forward
 *   9) Budget JE balancing
 *  10) Period close blocking budget postings
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

async function balanced(jeId: string) {
  const r = await pool.query(
    `SELECT debit, credit FROM budget_journal_lines WHERE budget_journal_id=$1`,
    [jeId]
  );
  const d = r.rows.reduce((a, x) => a + Number(x.debit), 0);
  const c = r.rows.reduce((a, x) => a + Number(x.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

beforeAll(async () => {
  await pool.query("SELECT 1");

  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "BUDGET-TENANT",
      tenantName: "BudgetTenant",
      companyName: "BudgetCo",
      name: "Admin",
      email: `budget-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;

  // Provision budget structures
  await pool.query(`SELECT install_budget_structures($1,$2)`, [
    tenantId,
    companyId,
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe("Budget + Commitment Control E2E", () => {
  let budgetId: string;
  let preEncId: string;
  let encId: string;
  let expenseId: string;
  let poId: string;
  let billId: string;

  // ---------------------------------------------------------
  // 1) Create approved budget
  // ---------------------------------------------------------
  test("Create budget", async () => {
    const b = await pool.query(
      `
      INSERT INTO budgets
        (id,tenant_id,company_id,year,total_amount,status)
      VALUES
        (gen_random_uuid(),$1,$2,2025,10000,'DRAFT')
      RETURNING id
      `,
      [tenantId, companyId]
    );

    budgetId = b.rows[0].id;

    // Approve budget
    await pool.query(
      `UPDATE budgets SET status='APPROVED' WHERE id=$1`,
      [budgetId]
    );
  });

  // ---------------------------------------------------------
  // 2) Pre-encumbrance on Purchase Request
  // ---------------------------------------------------------
  test("Purchase Request triggers pre-encumbrance", async () => {
    const pr = await pool.query(
      `
      INSERT INTO purchase_request
        (id,tenant_id,company_id,description,amount,budget_id)
      VALUES
        (gen_random_uuid(),$1,$2,'PR-1',2000,$3)
      RETURNING id
      `,
      [tenantId, companyId, budgetId]
    );

    const prId = pr.rows[0].id;

    const preEnc = await pool.query(
      `SELECT create_pre_encumbrance($1) AS je`,
      [prId]
    );

    preEncId = preEnc.rows[0].je;
    expect(preEncId).toBeDefined();

    await balanced(preEncId);

    const bal = await pool.query(
      `SELECT pre_encumbered FROM budgets WHERE id=$1`,
      [budgetId]
    );

    expect(Number(bal.rows[0].pre_encumbered)).toBe(2000);
  });

  // ---------------------------------------------------------
  // 3) Encumbrance on Purchase Order creation
  // ---------------------------------------------------------
  test("PO creation consumes pre-encumbrance → creates encumbrance", async () => {
    // Create PO
    const po = await pool.query(
      `
      INSERT INTO purchase_order
        (id,tenant_id,company_id,total_amount,budget_id,description)
      VALUES
        (gen_random_uuid(),$1,$2,2000,$3,'PO-1')
      RETURNING id
      `,
      [tenantId, companyId, budgetId]
    );

    poId = po.rows[0].id;

    const encJE = await pool.query(
      `SELECT create_encumbrance($1) AS je`,
      [poId]
    );

    encId = encJE.rows[0].je;

    await balanced(encId);

    const b = await pool.query(
      `SELECT pre_encumbered, encumbered FROM budgets WHERE id=$1`,
      [budgetId]
    );

    expect(Number(b.rows[0].pre_encumbered)).toBe(0);
    expect(Number(b.rows[0].encumbered)).toBe(2000);
  });

  // ---------------------------------------------------------
  // 4) Vendor Bill consumes encumbrance → creates expense
  // ---------------------------------------------------------
  test("Vendor Bill reduces encumbrance & creates expense", async () => {
    const vb = await pool.query(
      `
      INSERT INTO vendor_bill
       (id,tenant_id,company_id,bill_number,bill_date,total_amount,currency_id)
      VALUES
       (gen_random_uuid(),$1,$2,'BILL-BUD-1',NOW(),2000,
        (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
      RETURNING id
      `,
      [tenantId, companyId]
    );

    billId = vb.rows[0].id;

    await pool.query(
      `
      INSERT INTO vendor_bill_items
        (id,bill_id,tenant_id,company_id,description,amount,budget_id)
      VALUES
        (gen_random_uuid(),$1,$2,$3,'Office Supplies',2000,$4)
      `,
      [billId, tenantId, companyId, budgetId]
    );

    const expJE = await pool.query(
      `SELECT consume_encumbrance_create_expense($1) AS je`,
      [billId]
    );

    expenseId = expJE.rows[0].je;

    await balanced(expenseId);

    const b = await pool.query(
      `SELECT encumbered, actual_expense FROM budgets WHERE id=$1`,
      [budgetId]
    );

    expect(Number(b.rows[0].encumbered)).toBe(0);
    expect(Number(b.rows[0].actual_expense)).toBe(2000);
  });

  // ---------------------------------------------------------
  // 5) Budget availability control (BAC) blocks overspend
  // ---------------------------------------------------------
  test("BAC prevents overspend", async () => {
    const pr = await pool.query(
      `
      INSERT INTO purchase_request
        (id,tenant_id,company_id,description,amount,budget_id)
      VALUES
        (gen_random_uuid(),$1,$2,'PR-OVR',9000,$3)
      RETURNING id
      `,
      [tenantId, companyId, budgetId]
    );

    await expect(
      pool.query(`SELECT create_pre_encumbrance($1)`, [pr.rows[0].id])
    ).rejects.toThrow();
  });

  // ---------------------------------------------------------
  // 6) Cancel PO → encumbrance reversal
  // ---------------------------------------------------------
  test("Cancel PO reverses encumbrance", async () => {
    await pool.query(
      `UPDATE purchase_order SET status='CANCELLED' WHERE id=$1`,
      [poId]
    );

    const rev = await pool.query(
      `SELECT reverse_encumbrance($1) AS je`,
      [poId]
    );

    await balanced(rev.rows[0].je);

    const b = await pool.query(
      `SELECT encumbered FROM budgets WHERE id=$1`,
      [budgetId]
    );

    expect(Number(b.rows[0].encumbered)).toBe(0);
  });

  // ---------------------------------------------------------
  // 7) Budget Revision
  // ---------------------------------------------------------
  test("Budget revision increases available funds", async () => {
    await pool.query(
      `UPDATE budgets SET total_amount = total_amount + 5000 WHERE id=$1`,
      [budgetId]
    );

    const b = await pool.query(
      `SELECT total_amount FROM budgets WHERE id=$1`,
      [budgetId]
    );

    expect(Number(b.rows[0].total_amount)).toBe(15000);
  });

  // ---------------------------------------------------------
  // 8) Year-end carry-forward
  // ---------------------------------------------------------
  test("Carry-forward remaining budget", async () => {
    const carry = await pool.query(
      `SELECT carry_forward_budget($1,'2025-12-31') AS je`,
      [budgetId]
    );

    const je = carry.rows[0].je;
    expect(je).toBeDefined();
    await balanced(je);
  });

  // ---------------------------------------------------------
  // 9) Period close blocks budget activity
  // ---------------------------------------------------------
  test("Period close blocks new encumbrances", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const p = await pool.query(
      `
      INSERT INTO accounting_periods
        (id,tenant_id,company_id,period_label,date_from,date_to,is_open)
      VALUES
        (gen_random_uuid(),$1,$2,'2025-BUD',$3,$3,true)
      RETURNING id
      `,
      [tenantId, companyId, today]
    );

    const periodId = p.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [periodId]);

    const pr = await pool.query(
      `
      INSERT INTO purchase_request
        (id,tenant_id,company_id,description,amount,budget_id)
      VALUES
        (gen_random_uuid(),$1,$2,'PR-BLK',1000,$3)
      RETURNING id
      `,
      [tenantId, companyId, budgetId]
    );

    await expect(
      pool.query(`SELECT create_pre_encumbrance($1)`, [pr.rows[0].id])
    ).rejects.toThrow();
  });
});
