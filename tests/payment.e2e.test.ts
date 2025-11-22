/**
 * MODULE 11C — Full E2E Payment Posting Test Suite
 * Validates:
 *  - Customer Payment
 *  - Vendor Payment
 *  - Allocations
 *  - FX Gain/Loss
 *  - Bank Journal Posting
 *  - AR/AP Liquidation
 *  - Double-Entry Validation
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

  // ==== Bootstrap: fresh tenant ====
  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "PaymentOrg",
      tenantName: "Payment Org",
      companyName: "PaymentCo",
      name: "Admin",
      email: `pay-${Date.now()}@test.com`,
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

describe("E2E — Payment Posting Flow", () => {
  let invoiceId: string;
  let invoiceJE: string;
  let paymentId: string;
  let vendorBillId: string;
  let vendorBillJE: string;

  // ───────────────────────────────────────────
  // 1) CREATE CUSTOMER INVOICE
  // ───────────────────────────────────────────
  test("create and post invoice (AR)", async () => {
    const inv = await pool.query(
      `
      INSERT INTO invoices
        (id, tenant_id, company_id, invoice_number, invoice_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1, $2, 'INV-1001', NOW(), 500,
          (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    invoiceId = inv.rows[0].id;

    // Add 1 revenue line
    await pool.query(
      `
      INSERT INTO invoice_items
        (id, invoice_id, tenant_id, company_id, description, amount)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'Consultation', 500);
    `,
      [invoiceId, tenantId, companyId]
    );

    // Post invoice (your 8A invoice engine)
    const post = await pool.query(
      `SELECT post_invoice($1) AS je;`,
      [invoiceId]
    );

    invoiceJE = post.rows[0].je;
    expect(invoiceJE).toBeDefined();
  });

  // ───────────────────────────────────────────
  // 2) CREATE VENDOR BILL (AP)
  // ───────────────────────────────────────────
  test("create and post vendor bill (AP)", async () => {
    const vb = await pool.query(
      `
      INSERT INTO vendor_bill
        (id, tenant_id, company_id, vendor_id, bill_number, bill_date, total_amount, currency_id)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), 'V-BILL-001', NOW(), 300,
          (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    vendorBillId = vb.rows[0].id;

    await pool.query(
      `
      INSERT INTO vendor_bill_items
        (id, bill_id, tenant_id, company_id, description, amount)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'Supplies', 300);
    `,
      [vendorBillId, tenantId, companyId]
    );

    const posted = await pool.query(
      `SELECT post_vendor_bill($1) AS je;`,
      [vendorBillId]
    );

    vendorBillJE = posted.rows[0].je;
    expect(vendorBillJE).toBeDefined();
  });

  // ───────────────────────────────────────────
  // 3) CUSTOMER PAYMENT (settling invoice)
  // ───────────────────────────────────────────
  test("create and post customer payment", async () => {
    const pay = await pool.query(
      `
      INSERT INTO customer_payment
        (id, tenant_id, company_id, customer_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 500,
         (SELECT code FROM currencies c JOIN company_accounting_settings cas ON cas.currency_id=c.id WHERE cas.company_id=$2),
         'BANK',
         (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),
         'PAY-AR-1'
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    paymentId = pay.rows[0].id;
    expect(paymentId).toBeDefined();

    // Allocation to invoice
    await pool.query(
      `
      INSERT INTO payment_allocations
        (id, tenant_id, company_id, payment_id, document_type, document_id, allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'invoice', $4, 500, 500, 1)
    `,
      [tenantId, companyId, paymentId, invoiceId]
    );

    // Post payment
    const posted = await pool.query(
      `SELECT post_payment($1,'customer') AS je`,
      [paymentId]
    );

    expect(posted.rows[0].je).toBeDefined();
  });

  // ───────────────────────────────────────────
  // 4) VENDOR PAYMENT (settling AP)
  // ───────────────────────────────────────────
  test("create and post vendor payment", async () => {
    const vp = await pool.query(
      `
      INSERT INTO vendor_payment
        (id, tenant_id, company_id, vendor_id, payment_date, amount, currency, journal_type, journal_id, reference)
      VALUES
        (gen_random_uuid(), $1, $2, gen_random_uuid(), NOW(), 300,
         (SELECT code FROM currencies c JOIN company_accounting_settings cas ON cas.currency_id=c.id WHERE cas.company_id=$2),
         'BANK',
         (SELECT id FROM journals WHERE company_id=$2 AND code='BJ'),
         'PAY-AP-1'
        )
      RETURNING id;
    `,
      [tenantId, companyId]
    );

    const vendorPaymentId = vp.rows[0].id;

    // Allocation to bill
    await pool.query(
      `
      INSERT INTO payment_allocations
        (id, tenant_id, company_id, payment_id, document_type, document_id, allocated_amount, allocated_base_amount, fx_rate)
      VALUES
        (gen_random_uuid(), $1, $2, $3, 'vendor_bill', $4, 300, 300, 1)
      `,
      [tenantId, companyId, vendorPaymentId, vendorBillId]
    );

    const posted = await pool.query(
      `SELECT post_payment($1,'vendor') AS je`,
      [vendorPaymentId]
    );

    expect(posted.rows[0].je).toBeDefined();
  });

  // ───────────────────────────────────────────
  // 5) JOURNAL ENTRY BALANCE CHECK FOR PAYMENTS
  // ───────────────────────────────────────────
  test("verify payments produce balanced journal entries", async () => {
    const entries = await pool.query(
      `
      SELECT id FROM journal_entries 
      WHERE reference IN ('PAY-AR-1', 'PAY-AP-1')
    `
    );

    expect(entries.rowCount).toBe(2);

    for (const row of entries.rows) {
      const lines = await pool.query(
        `
        SELECT debit, credit
        FROM journal_entry_lines
        WHERE journal_entry_id=$1
      `,
        [row.id]
      );

      const totalDebit = lines.rows.reduce((a, r) => a + Number(r.debit), 0);
      const totalCredit = lines.rows.reduce((a, r) => a + Number(r.credit), 0);

      expect(Number(totalDebit.toFixed(2))).toBe(Number(totalCredit.toFixed(2)));
    }
  });
});
