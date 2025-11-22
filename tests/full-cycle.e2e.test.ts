/**
 * MODULE 13 — Full AR/AP Accounting Cycle Simulation
 *
 * Sequence:
 *   1) Tenant provisioning (via /tenant-signup)
 *   2) AR invoice posting
 *   3) Customer payment posting (partial + full)
 *   4) AP vendor bill posting
 *   5) Vendor payment posting
 *   6) FX exposure creation
 *   7) FX revaluation → JE created
 *   8) Reverse FX revaluation
 *   9) Reverse AR, AP, payments
 *  10) Create & close period → block postings
 *  11) Reopen period → allow postings again
 *
 * This is the strongest accounting integrity test of your ERP.
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
let userId: string;

beforeAll(async () => {
  await pool.query("SELECT 1");

  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "FullCycleORG",
      tenantName: "Full Cycle Tenant",
      companyName: "FullCycleCo",
      name: "Admin",
      email: `full-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
  userId = signup.body.userId;
});

afterAll(async () => {
  await pool.end();
});

/** Utility to check if JE balances */
async function expectBalanced(journalEntryId: string) {
  const lines = await pool.query(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [journalEntryId]
  );
  const d = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
  const c = lines.rows.reduce((a, r) => a + Number(r.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("FULL AR/AP + FX + REVERSAL + PERIOD LOCKING CYCLE", () => {
  let invoiceId: string;
  let invoiceJE: string;

  let payment1Id: string;
  let payment2Id: string;

  let billId: string;
  let billJE: string;

  let billPayId: string;

  let fxExposureJE: string;
  let revalRunId: string;
  let revalJE: string;

  let periodId: string;

  // ─────────────────────────────────────────────────────
  // 1) AR Invoice Posting
  // ─────────────────────────────────────────────────────
  test("Post AR invoice", async () => {
    const inv = await pool.query(
      `
       INSERT INTO invoices 
         (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
       VALUES 
         (gen_random_uuid(), $1, $2, 'INV-FULL-1', NOW(), 1000,
           (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
         )
       RETURNING id;
      `,
      [tenantId, companyId]
    );

    invoiceId = inv.rows[0].id;

    await pool.query(
      `
       INSERT INTO invoice_items
         (id, invoice_id, tenant_id, company_id, description, amount)
       VALUES
         (gen_random_uuid(), $1, $2, $3, 'Full-cycle service', 1000)
      `,
      [invoiceId, tenantId, companyId]
    );

    const post = await pool.query(`SELECT post_invoice($1) AS je`, [invoiceId]);
    invoiceJE = post.rows[0].je;
    await expectBalanced(invoiceJE);
  });

  // ─────────────────────────────────────────────────────
  // 2) CUSTOMER PAYMENT: partial
  // ─────────────────────────────────────────────────────
  test("Post partial customer payment", async () => {
    const currency = await pool.query(
      `SELECT code FROM currencies c 
       JOIN company_accounting_settings cas ON cas.currency_id=c.id 
       WHERE cas.company_id=$1 LIMIT 1`,
      [companyId]
    );

    const curCode = currency.rows[0].code;

    const p1 = await pool.query(
      `
      INSERT INTO customer_payment
        (id, tenant_id, company_id, customer_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 400, $3,
         'BANK',
         (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),
         'PM-FULL-1')
      RETURNING id
      `,
      [tenantId, companyId, curCode]
    );

    payment1Id = p1.rows[0].id;

    // Partial allocation
    await pool.query(
      `
      INSERT INTO payment_allocations
        (id, tenant_id, company_id, payment_id, document_type, document_id,
         allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'invoice', $4, 400, 400, 1)
      `,
      [tenantId, companyId, payment1Id, invoiceId]
    );

    const post = await pool.query(
      `SELECT post_payment($1,'customer') AS je`,
      [payment1Id]
    );

    await expectBalanced(post.rows[0].je);
  });

  // ─────────────────────────────────────────────────────
  // 3) CUSTOMER PAYMENT: full payoff
  // ─────────────────────────────────────────────────────
  test("Post final customer payment", async () => {
    const currency = await pool.query(
      `SELECT code FROM currencies c 
       JOIN company_accounting_settings cas ON cas.currency_id=c.id 
       WHERE cas.company_id=$1 LIMIT 1`,
      [companyId]
    );
    const cur = currency.rows[0].code;

    const p2 = await pool.query(
      `
      INSERT INTO customer_payment (id, tenant_id, company_id, customer_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 600, $3,
        'BANK', (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'), 'PM-FULL-2')
      RETURNING id;
      `,
      [tenantId, companyId, cur]
    );

    payment2Id = p2.rows[0].id;

    await pool.query(
      `
      INSERT INTO payment_allocations (id, tenant_id, company_id, payment_id, document_type, document_id,
        allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'invoice', $4, 600, 600, 1)
      `,
      [tenantId, companyId, payment2Id, invoiceId]
    );

    const post = await pool.query(
      `SELECT post_payment($1,'customer') AS je`,
      [payment2Id]
    );
    const je = post.rows[0].je;
    await expectBalanced(je);
  });

  // ─────────────────────────────────────────────────────
  // 4) Vendor Bill → Posting
  // ─────────────────────────────────────────────────────
  test("Post AP vendor bill", async () => {
    const bill = await pool.query(
      `
      INSERT INTO vendor_bill (id, tenant_id, company_id, vendor_id, bill_number, bill_date, total_amount, currency_id)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'BILL-FULL-1', NOW(), 300,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
      RETURNING id;
      `,
      [tenantId, companyId]
    );

    billId = bill.rows[0].id;

    await pool.query(
      `INSERT INTO vendor_bill_items
        (id, bill_id, tenant_id, company_id, description, amount)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Supplies', 300)`,
      [billId, tenantId, companyId]
    );

    const post = await pool.query(
      `SELECT post_vendor_bill($1) AS je`,
      [billId]
    );

    billJE = post.rows[0].je;
    await expectBalanced(billJE);
  });

  // ─────────────────────────────────────────────────────
  // 5) Vendor Payment → Posting
  // ─────────────────────────────────────────────────────
  test("Vendor payment posting", async () => {
    const currency = await pool.query(
      `SELECT code FROM currencies c 
       JOIN company_accounting_settings cas ON cas.currency_id=c.id 
       WHERE cas.company_id=$1 LIMIT 1`,
      [companyId]
    );

    const cur = currency.rows[0].code;

    const vp = await pool.query(
      `
      INSERT INTO vendor_payment (id, tenant_id, company_id, vendor_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 300, $3, 'BANK',
         (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'), 'VPM-FULL-1')
      RETURNING id;
      `,
      [tenantId, companyId, cur]
    );

    billPayId = vp.rows[0].id;

    await pool.query(
      `
      INSERT INTO payment_allocations
        (id, tenant_id, company_id, payment_id, document_type, document_id,
         allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'vendor_bill', $4, 300, 300, 1)
      `,
      [tenantId, companyId, billPayId, billId]
    );

    const post = await pool.query(
      `SELECT post_payment($1,'vendor') AS je`,
      [billPayId]
    );

    await expectBalanced(post.rows[0].je);
  });

  // ─────────────────────────────────────────────────────
  // 6) FX Exposure → FX Revaluation
  // ─────────────────────────────────────────────────────
  test("Create FX exposure then run FX revaluation", async () => {
    const currency = await pool.query(
      `SELECT id FROM currencies WHERE code <> (SELECT code FROM currencies c JOIN company_accounting_settings cas ON cas.currency_id=c.id WHERE cas.company_id=$1 LIMIT 1) LIMIT 1`,
      [companyId]
    );

    const fcId = currency.rows[0].id;

    // Create exposure JE
    const je = uuidv4();
    await pool.query(
      `
      INSERT INTO journal_entries (id, tenant_id, company_id, journal_id, entry_date, currency_id, fx_rate, ref)
      VALUES ($1, $2, $3, (SELECT id FROM journals WHERE company_id=$3 LIMIT 1), NOW(), $4, 1.0, 'FX-EXPOSURE-13')
      `,
      [je, tenantId, companyId, fcId]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines (id, journal_entry_id, tenant_id, company_id, account_id, debit, credit)
      VALUES
        (gen_random_uuid(), $1, $2, $3, (SELECT ar_account_id FROM company_accounting_settings WHERE company_id=$3), 1000, 0),
        (gen_random_uuid(), $1, $2, $3, (SELECT id FROM account_chart WHERE company_id=$3 LIMIT 1), 0, 1000)
      `,
      [je, tenantId, companyId]
    );

    fxExposureJE = je;

    // Run revaluation
    const reval = await pool.query(
      `SELECT run_fx_revaluation($1,$2,NOW()::date) AS run_id`,
      [tenantId, companyId]
    );

    revalRunId = reval.rows[0].run_id;
    expect(revalRunId).toBeDefined();

    const revalJEQuery = await pool.query(
      `SELECT id FROM journal_entries WHERE reference ILIKE '%FX Revaluation%' ORDER BY created_at DESC LIMIT 1`
    );

    revalJE = revalJEQuery.rows[0].id;
    await expectBalanced(revalJE);
  });

  // ─────────────────────────────────────────────────────
  // 7) Reverse FX Revaluation
  // ─────────────────────────────────────────────────────
  test("Reverse FX revaluation", async () => {
    const rev = await pool.query(
      `SELECT reverse_fx_revaluation($1) AS rev`,
      [revalRunId]
    );
    const revJe = rev.rows[0].rev;
    expect(revJe).toBeDefined();
    await expectBalanced(revJe);
  });

  // ─────────────────────────────────────────────────────
  // 8) Reverse AR, AP, and Payments
  // ─────────────────────────────────────────────────────
  test("Reverse AR, AP, and payments", async () => {
    // Reverse invoice JE
    const revInv = await pool.query(
      `SELECT reverse_journal_entry($1,NOW()::date) AS rev`,
      [invoiceJE]
    );
    await expectBalanced(revInv.rows[0].rev);

    // Reverse vendor bill JE
    const revBill = await pool.query(
      `SELECT reverse_journal_entry($1,NOW()::date) AS rev`,
      [billJE]
    );
    await expectBalanced(revBill.rows[0].rev);

    // Reverse payments
    const revPay1 = await pool.query(
      `SELECT reverse_payment($1) AS rev`, [payment1Id]
    );
    expect(revPay1.rows[0].rev).toBeDefined();

    const revPay2 = await pool.query(
      `SELECT reverse_payment($1) AS rev`, [payment2Id]
    );
    expect(revPay2.rows[0].rev).toBeDefined();

    const revPayV = await pool.query(
      `SELECT reverse_payment($1) AS rev`, [billPayId]
    );
    expect(revPayV.rows[0].rev).toBeDefined();
  });

  // ─────────────────────────────────────────────────────
  // 9) Close period → posting must fail
  // ─────────────────────────────────────────────────────
  test("Period closing blocks postings", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const period = await pool.query(
      `
      INSERT INTO accounting_periods
        (id, tenant_id, company_id, period_label, date_from, date_to, is_open)
      VALUES
        (gen_random_uuid(), $1, $2, '2025-MAY', $3, $3, true)
      RETURNING id`,
      [tenantId, companyId, today]
    );

    periodId = period.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [periodId]);

    // Try to post invoice in closed period
    const blockedInvoice = await pool.query(
      `
       INSERT INTO invoices (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
       VALUES (gen_random_uuid(), $1, $2, 'BLK', NOW(), 50,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
       RETURNING id
      `,
      [tenantId, companyId]
    );

    await expect(
      pool.query(`SELECT post_invoice($1)`, [blockedInvoice.rows[0].id])
    ).rejects.toThrow();
  });

  // ─────────────────────────────────────────────────────
  // 10) Reopen → posting works again
  // ─────────────────────────────────────────────────────
  test("Reopening period allows posting", async () => {
    await pool.query(
      `UPDATE accounting_periods SET is_open=true WHERE id=$1`,
      [periodId]
    );

    const newInv = await pool.query(
      `
       INSERT INTO invoices (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
       VALUES (gen_random_uuid(), $1, $2, 'UNBLK', NOW(), 70,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2))
       RETURNING id
      `,
      [tenantId, companyId]
    );

    const post = await pool.query(
      `SELECT post_invoice($1) AS je`,
      [newInv.rows[0].id]
    );

    await expectBalanced(post.rows[0].je);
  });
});
