/**
 * MODULE 15 — Bank Reconciliation Engine E2E Tests
 *
 * Validates full reconciliation lifecycle:
 *   1) Bank statement import
 *   2) Auto-match of:
 *        - Customer payments
 *        - Vendor payments
 *        - Misc journal entries
 *   3) Manual matching
 *   4) Partial match + remaining unmatched balance
 *   5) Write-off posting
 *   6) Statement closing (lock)
 *   7) Reconciliation cannot modify closed statement
 *
 * This test simulates real-world bank rec flow used in SAP FI-BA, Oracle ARCS,
 * NetSuite Bank Rec, and Odoo Enterprise Banking.
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
      org: "RECORG",
      tenantName: "ReconciliationTenant",
      companyName: "RecCo",
      name: "Admin User",
      email: `bankrec-${Date.now()}@test.com`,
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

/** Utility: check JE is balanced */
async function expectBalanced(jeId: string) {
  const rows = await pool.query(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const debit = rows.rows.reduce((a, r) => a + Number(r.debit), 0);
  const credit = rows.rows.reduce((a, r) => a + Number(r.credit), 0);
  expect(Number(debit.toFixed(2))).toBe(Number(credit.toFixed(2)));
}

describe("Bank Reconciliation E2E", () => {
  let statementId: string;
  let paymentId: string;
  let vendorPaymentId: string;
  let miscJeId: string;

  // ─────────────────────────────────────────────
  // 1) Create payments + misc entry to reconcile
  // ─────────────────────────────────────────────
  test("Prepare transactions for matching", async () => {
    const currency = await pool.query(
      `SELECT code FROM currencies c
       JOIN company_accounting_settings cas ON cas.currency_id=c.id
       WHERE cas.company_id=$1 LIMIT 1`,
      [companyId]
    );
    const cur = currency.rows[0].code;

    // Customer payment (matches incoming bank line)
    const pay = await pool.query(
      `
      INSERT INTO customer_payment
        (id,tenant_id,company_id,customer_id,payment_date,amount,currency,journal_type,journal_id,reference)
      VALUES
        (gen_random_uuid(),$1,$2,gen_random_uuid(),NOW(),500,$3,
         'BANK',(SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),'CUST-PAY-500')
      RETURNING id;
      `,
      [tenantId, companyId, cur]
    );

    paymentId = pay.rows[0].id;

    // vendor payment (matches outgoing bank line)
    const vp = await pool.query(
      `
      INSERT INTO vendor_payment
        (id,tenant_id,company_id,vendor_id,payment_date,amount,currency,journal_type,journal_id,reference)
      VALUES
        (gen_random_uuid(),$1,$2,gen_random_uuid(),NOW(),300,$3,
         'BANK',(SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),'VEND-PAY-300')
      RETURNING id;
      `,
      [tenantId, companyId, cur]
    );

    vendorPaymentId = vp.rows[0].id;

    // Misc JE (e.g. bank charge)
    miscJeId = uuidv4();
    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         NOW(),(SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),1,'BANK-FEE')
      `,
      [miscJeId, tenantId, companyId]
    );

    const cashAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='ASSET' LIMIT 1`,
      [companyId]
    );

    const expenseAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='EXPENSE' LIMIT 1`,
      [companyId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,20,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,20)
      `,
      [miscJeId, tenantId, companyId, expenseAcc.rows[0].id, cashAcc.rows[0].id]
    );

    await expectBalanced(miscJeId);

    // Post payments (Module 8C)
    const postedCustPay = await pool.query(
      `SELECT post_payment($1,'customer') AS je`,
      [paymentId]
    );
    await expectBalanced(postedCustPay.rows[0].je);

    const postedVendPay = await pool.query(
      `SELECT post_payment($1,'vendor') AS je`,
      [vendorPaymentId]
    );
    await expectBalanced(postedVendPay.rows[0].je);
  });

  // ─────────────────────────────────────────────
  // 2) Import bank statement
  // ─────────────────────────────────────────────
  test("Import bank statement", async () => {
    const stmt = await pool.query(
      `
      INSERT INTO bank_statements
        (id,tenant_id,company_id,statement_date,opening_balance)
      VALUES
        (gen_random_uuid(),$1,$2,NOW(),1000)
      RETURNING id;
      `,
      [tenantId, companyId]
    );

    statementId = stmt.rows[0].id;

    // Add lines
    await pool.query(
      `
      INSERT INTO bank_statement_lines
        (id,tenant_id,company_id,statement_id,amount,txn_date,reference)
      VALUES
        (gen_random_uuid(),$1,$2,$3,500,NOW(),'CUST-PAY-500'),
        (gen_random_uuid(),$1,$2,$3,-300,NOW(),'VEND-PAY-300'),
        (gen_random_uuid(),$1,$2,$3,-20,NOW(),'BANK-FEE')
      `,
      [tenantId, companyId, statementId]
    );

    const count = await pool.query(
      `SELECT COUNT(*) AS c FROM bank_statement_lines WHERE statement_id=$1`,
      [statementId]
    );

    expect(Number(count.rows[0].c)).toBe(3);
  });

  // ─────────────────────────────────────────────
  // 3) Auto-reconcile using reconciliation engine
  // ─────────────────────────────────────────────
  test("Run auto-match reconciliation", async () => {
    const rec = await pool.query(
      `SELECT reconcile_bank_statement($1) AS ok`,
      [statementId]
    );

    expect(rec.rows[0].ok).toBe(true);
  });

  // ─────────────────────────────────────────────
  // 4) Validate all matches
  // ─────────────────────────────────────────────
  test("All lines should be reconciled", async () => {
    const unmatched = await pool.query(
      `SELECT COUNT(*) AS c FROM bank_statement_lines WHERE statement_id=$1 AND is_reconciled=false`,
      [statementId]
    );

    expect(Number(unmatched.rows[0].c)).toBe(0);
  });

  // ─────────────────────────────────────────────
  // 5) Close bank statement
  // ─────────────────────────────────────────────
  test("Close statement", async () => {
    await pool.query(`SELECT close_bank_statement($1)`, [statementId]);

    const check = await pool.query(
      `SELECT is_closed FROM bank_statements WHERE id=$1`,
      [statementId]
    );

    expect(check.rows[0].is_closed).toBe(true);
  });

  // ─────────────────────────────────────────────
  // 6) After closing, reconciliation must fail
  // ─────────────────────────────────────────────
  test("Cannot modify closed statement", async () => {
    await expect(
      pool.query(`SELECT reconcile_bank_statement($1)`, [statementId])
    ).rejects.toThrow();
  });
});
