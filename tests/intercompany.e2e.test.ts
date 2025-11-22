/**
 * MODULE 16 — Intercompany Accounting E2E Tests
 *
 * Validates:
 *  1. Create 2 companies under same tenant
 *  2. Customer invoice in CoA automatically becomes Vendor Bill in CoB
 *  3. AR → AP intercompany mirroring
 *  4. Due-from / Due-to intercompany accounts
 *  5. Intercompany balancing
 *  6. Reverse intercompany transactions
 *  7. FX revaluation on intercompany receivable/payable
 *  8. Period locking blocks intercompany postings
 */

import request from "supertest";
import { Pool } from "pg";
import app from "../src/app";
import { v4 as uuidv4 } from "uuid";

const pool = new Pool({
  connectionString: process.env.TEST_DB_URL,
});

let tenantId: string;
let companyA: string;
let companyB: string;

beforeAll(async () => {
  await pool.query("SELECT 1");

  // Create first company via signup
  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "ICO-Tenant",
      tenantName: "ICO Tenant",
      companyName: "Company A",
      name: "Admin A",
      email: `icoa-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyA = signup.body.companyId;

  // Create second company manually under same tenant
  const now = new Date();
  const coB = await pool.query(
    `
    INSERT INTO company
      (id, tenant_id, name, enabled, created_at, country_id)
    VALUES
      (gen_random_uuid(), $1, 'Company B', true, $2, '11111111-1111-4111-8111-111111111111')
    RETURNING id
    `,
    [tenantId, now]
  );

  companyB = coB.rows[0].id;

  // Install accounting settings for Company B via your provisioning engine
  await pool.query(`SELECT install_ifrs_coa($1,$2)`, [tenantId, companyB]);
  await pool.query(`SELECT install_default_journals($1,$2)`, [tenantId, companyB]);
  await pool.query(`SELECT install_company_accounting_settings($1,$2,$3)`,
    [tenantId, companyB, "11111111-1111-4111-8111-111111111111"]);
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

describe("Intercompany Accounting E2E", () => {
  let icInvoiceId: string;
  let icInvoiceJe: string;

  let mirroredBillId: string;
  let mirroredBillJe: string;

  // ───────────────────────────────────────────────
  // 1) Create Intercompany Customer Invoice in Company A
  // ───────────────────────────────────────────────
  test("Create IC invoice in Company A", async () => {
    const invoice = await pool.query(
      `
      INSERT INTO invoices
        (id,tenant_id,company_id,invoice_number,invoice_date,total_amount,currency_id,is_intercompany,intercompany_company_id)
      VALUES
        (gen_random_uuid(),$1,$2,'IC-INV-1',NOW(),1500,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2),
         true,$3)
      RETURNING id
      `,
      [tenantId, companyA, companyB]
    );

    icInvoiceId = invoice.rows[0].id;

    await pool.query(
      `
      INSERT INTO invoice_items
        (id,invoice_id,tenant_id,company_id,description,amount)
      VALUES
        (gen_random_uuid(),$1,$2,$3,'Intercompany Service',1500)
      `,
      [icInvoiceId, tenantId, companyA]
    );

    const post = await pool.query(`SELECT post_invoice($1) AS je`, [icInvoiceId]);
    icInvoiceJe = post.rows[0].je;

    expect(icInvoiceJe).toBeDefined();
    await expectBalanced(icInvoiceJe);
  });

  // ───────────────────────────────────────────────
  // 2) Verify Company B automatically received matching Vendor Bill
  // ───────────────────────────────────────────────
  test("Mirrored vendor bill created in Company B", async () => {
    const bill = await pool.query(
      `SELECT id FROM vendor_bill WHERE related_ic_invoice_id=$1 AND company_id=$2`,
      [icInvoiceId, companyB]
    );

    expect(bill.rowCount).toBe(1);
    mirroredBillId = bill.rows[0].id;

    const billPost = await pool.query(
      `SELECT post_vendor_bill($1) AS je`,
      [mirroredBillId]
    );

    mirroredBillJe = billPost.rows[0].je;
    expect(mirroredBillJe).toBeDefined();
    await expectBalanced(mirroredBillJe);
  });

  // ───────────────────────────────────────────────
  // 3) Validate Due-from / Due-to IC accounts
  // ───────────────────────────────────────────────
  test("Due-from / Due-to accounts match", async () => {
    const settingsA = await pool.query(
      `SELECT ic_due_from_account_id, ic_due_to_account_id
       FROM company_accounting_settings WHERE company_id=$1`,
      [companyA]
    );

    const settingsB = await pool.query(
      `SELECT ic_due_from_account_id, ic_due_to_account_id
       FROM company_accounting_settings WHERE company_id=$1`,
      [companyB]
    );

    const A_dueFrom = settingsA.rows[0].ic_due_from_account_id;
    const B_dueTo   = settingsB.rows[0].ic_due_to_account_id;

    expect(A_dueFrom).toBeDefined();
    expect(B_dueTo).toBeDefined();

    // Check JE lines
    const linesA = await pool.query(
      `
      SELECT account_id, debit, credit
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [icInvoiceJe]
    );

    const linesB = await pool.query(
      `
      SELECT account_id, debit, credit
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [mirroredBillJe]
    );

    const aHasDueFrom = linesA.rows.some(r => r.account_id === A_dueFrom);
    const bHasDueTo   = linesB.rows.some(r => r.account_id === B_dueTo);

    expect(aHasDueFrom).toBe(true);
    expect(bHasDueTo).toBe(true);
  });

  // ───────────────────────────────────────────────
  // 4) Reverse both sides entirely
  // ───────────────────────────────────────────────
  test("Reverse IC entries", async () => {
    const revA = await pool.query(
      `SELECT reverse_journal_entry($1,NOW()::date) AS rev`,
      [icInvoiceJe]
    );
    const revB = await pool.query(
      `SELECT reverse_journal_entry($1,NOW()::date) AS rev`,
      [mirroredBillJe]
    );

    await expectBalanced(revA.rows[0].rev);
    await expectBalanced(revB.rows[0].rev);
  });

  // ───────────────────────────────────────────────
  // 5) FX Revaluation on intercompany balances
  // ───────────────────────────────────────────────
  test("Run FX revaluation on IC balances", async () => {
    const run = await pool.query(
      `SELECT run_fx_revaluation($1,$2,NOW()::date) AS run`,
      [tenantId, companyA]
    );

    expect(run.rows[0].run).toBeDefined();

    // retrieve the FX JE
    const fxje = await pool.query(
      `
      SELECT id FROM journal_entries 
      WHERE reference ILIKE '%FX Revaluation%' 
      ORDER BY created_at DESC LIMIT 1
      `
    );

    await expectBalanced(fxje.rows[0].id);
  });

  // ───────────────────────────────────────────────
  // 6) Period Lock prevents IC posting
  // ───────────────────────────────────────────────
  test("Period lock blocks IC posting", async () => {
    const today = new Date().toISOString().slice(0,10);

    const period = await pool.query(
      `
      INSERT INTO accounting_periods
        (id,tenant_id,company_id,period_label,date_from,date_to,is_open)
      VALUES
        (gen_random_uuid(),$1,$2,'2025-IC',$3,$3,true)
      RETURNING id
      `,
      [tenantId, companyA, today]
    );

    const periodId = period.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [periodId]);

    // Posting intercompany invoice again must fail
    const inv = await pool.query(
      `
      INSERT INTO invoices
        (id,tenant_id,company_id,invoice_number,invoice_date,total_amount,
         currency_id,is_intercompany,intercompany_company_id)
      VALUES
        (gen_random_uuid(),$1,$2,'IC-BLOCK',NOW(),500,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2),
         true,$3)
      RETURNING id
      `,
      [tenantId, companyA, companyB]
    );

    await expect(
      pool.query(`SELECT post_invoice($1)`, [inv.rows[0].id])
    ).rejects.toThrow();
  });
});
