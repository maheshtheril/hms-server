/**
 * MODULE 12 — Reversals + Period Locking E2E Tests
 *
 * Tests the following end-to-end:
 *  1) Invoice posting → reversal
 *  2) Vendor bill posting → reversal
 *  3) Payment posting → reversal
 *  4) Period closing → blocking new postings
 *  5) Reversal attempt in closed period → must fail
 *  6) Period reopening → reversal must succeed
 *  7) Double-entry integrity for all reversals
 *
 * IMPORTANT:
 *   - Based on schema used at /mnt/data/schema.sql
 *   - Uses functions from Modules 8A–8D and provisioning from 9A–9C
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
      org: "PeriodLockOrg",
      tenantName: "PeriodLock Tenant",
      companyName: "PeriodCo",
      name: "Admin User",
      email: `period-${Date.now()}@example.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
  userId = signup.body.userId;
});

afterAll(async () => {
  await pool.end();
});

describe("E2E — Reversals + Period Locking", () => {
  let invoiceId: string;
  let invoiceJE: string;

  let billId: string;
  let billJE: string;

  let paymentId: string;
  let paymentJE: string;

  let periodId: string;

  // ───────────────────────────────────────────
  // 1) INVOICE POSTING + REVERSAL
  // ───────────────────────────────────────────
  test("invoice posting + reversal works", async () => {
    // Create invoice
    const inv = await pool.query(
      `
      INSERT INTO invoices
        (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1, $2, 'INV-REV-1', NOW(), 400,
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
        (gen_random_uuid(), $1, $2, $3, 'Service', 400)
    `,
      [invoiceId, tenantId, companyId]
    );

    const post = await pool.query(`SELECT post_invoice($1) AS je`, [invoiceId]);
    invoiceJE = post.rows[0].je;
    expect(invoiceJE).toBeDefined();

    // Reverse invoice
    const reverse = await pool.query(
      `SELECT reverse_journal_entry($1, NOW()::date) AS rev`,
      [invoiceJE]
    );
    expect(reverse.rows[0].rev).toBeDefined();

    const revJeId = reverse.rows[0].rev;

    // Verify reversal JE balance
    const lines = await pool.query(
      `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
      [revJeId]
    );

    const totalDebit = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
    const totalCredit = lines.rows.reduce((a, r) => a + Number(r.credit), 0);
    expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
  });

  // ───────────────────────────────────────────
  // 2) VENDOR BILL POSTING + REVERSAL
  // ───────────────────────────────────────────
  test("vendor bill posting + reversal works", async () => {
    const vb = await pool.query(
      `
      INSERT INTO vendor_bill
        (id, tenant_id, company_id, vendor_id, bill_number, bill_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), 'BILL-REV-1', NOW(), 250,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );
    billId = vb.rows[0].id;

    await pool.query(
      `
      INSERT INTO vendor_bill_items
        (id, bill_id, tenant_id, company_id, description, amount)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'Chemicals', 250)
    `,
      [billId, tenantId, companyId]
    );

    const post = await pool.query(`SELECT post_vendor_bill($1) AS je`, [billId]);
    billJE = post.rows[0].je;

    const reverse = await pool.query(
      `SELECT reverse_journal_entry($1, NOW()::date) AS rev`,
      [billJE]
    );
    const revJe = reverse.rows[0].rev;

    // Check balancing
    const lines = await pool.query(
      `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
      [revJe]
    );

    const d = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
    const c = lines.rows.reduce((a, r) => a + Number(r.credit), 0);
    expect(d.toFixed(2)).toBe(c.toFixed(2));
  });

  // ───────────────────────────────────────────
  // 3) PAYMENT POSTING + REVERSAL
  // ───────────────────────────────────────────
  test("payment posting + reversal works", async () => {
    const pay = await pool.query(
      `
      INSERT INTO customer_payment
        (id, tenant_id, company_id, customer_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 200,
         (SELECT code FROM currencies c JOIN company_accounting_settings cas ON cas.currency_id=c.id WHERE cas.company_id=$2),
         'BANK',
         (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),
         'PM-REV-1'
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    paymentId = pay.rows[0].id;

    // allocate to no document (pure payment entry)
    await pool.query(
      `
      INSERT INTO payment_allocations
        (id, tenant_id, company_id, payment_id, document_type, document_id, allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'invoice', gen_random_uuid(), 200, 200, 1)
    `,
      [tenantId, companyId, paymentId]
    );

    const post = await pool.query(`SELECT post_payment($1,'customer') AS je`, [paymentId]);
    paymentJE = post.rows[0].je;

    const reverse = await pool.query(
      `SELECT reverse_journal_entry($1, NOW()::date) AS rev`,
      [paymentJE]
    );

    const revJe = reverse.rows[0].rev;

    const lines = await pool.query(
      `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
      [revJe]
    );

    const d = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
    const c = lines.rows.reduce((a, r) => a + Number(r.credit), 0);

    expect(d.toFixed(2)).toBe(c.toFixed(2));
  });

  // ───────────────────────────────────────────
  // 4) PERIOD CREATION → LOCKING
  // ───────────────────────────────────────────
  test("create accounting period & close it", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const period = await pool.query(
      `
      INSERT INTO accounting_periods
        (id, tenant_id, company_id, period_label, date_from, date_to, is_open)
      VALUES
        (gen_random_uuid(), $1, $2, '2025-APR', $3, $3, true)
      RETURNING id;
    `,
      [tenantId, companyId, today]
    );

    periodId = period.rows[0].id;

    expect(periodId).toBeDefined();

    // Now close it
    const close = await pool.query(`SELECT close_period($1)`, [periodId]);

    const check = await pool.query(
      `SELECT is_open FROM accounting_periods WHERE id=$1`,
      [periodId]
    );
    expect(check.rows[0].is_open).toBe(false);
  });

  // ───────────────────────────────────────────
  // 5) NEW POSTING IN CLOSED PERIOD MUST FAIL
  // ───────────────────────────────────────────
  test("posting is blocked in closed period", async () => {
    await expect(
      pool.query(
        `SELECT post_invoice($1)`,
        [
          (
            await pool.query(
              `INSERT INTO invoices
                 (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
               VALUES
                 (gen_random_uuid(), $2, $3, 'BLOCKED', NOW(), 50,
                  (SELECT currency_id FROM company_accounting_settings WHERE company_id=$3)
                 )
               RETURNING id`,
              [tenantId, tenantId, companyId]
            )
          ).rows[0].id,
        ]
      )
    ).rejects.toThrow();
  });

  // ───────────────────────────────────────────
  // 6) REVERSAL IN CLOSED PERIOD MUST FAIL
  // ───────────────────────────────────────────
  test("reversal in closed period fails", async () => {
    await expect(
      pool.query(`SELECT reverse_journal_entry($1, NOW()::date)`, [invoiceJE])
    ).rejects.toThrow();
  });

  // ───────────────────────────────────────────
  // 7) REOPEN PERIOD → REVERSAL SUCCEEDS
  // ───────────────────────────────────────────
  test("reopening period allows reversal again", async () => {
    await pool.query(
      `UPDATE accounting_periods SET is_open=true WHERE id=$1`,
      [periodId]
    );

    const rev = await pool.query(
      `SELECT reverse_journal_entry($1, NOW()::date) AS rev`,
      [invoiceJE]
    );

    expect(rev.rows[0].rev).toBeDefined();
  });
});
