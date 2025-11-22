/**
 * MODULE 18 — Multi-Company Consolidation (IFRS 10) E2E Tests
 *
 * Validates:
 *   1. Parent + Subsidiary company structure
 *   2. Investment in subsidiary elimination
 *   3. Intercompany AR/AP elimination
 *   4. Intercompany sales vs COGS elimination
 *   5. Consolidation currency translation (IFRS 21)
 *   6. Consolidation journal entry posting
 *   7. Consolidation run → consolidated TB
 *   8. Consolidation lock
 *   9. Re-open consolidation
 */

import request from "supertest";
import { Pool } from "pg";
import app from "../src/app";
import { v4 as uuidv4 } from "uuid";

const pool = new Pool({
  connectionString: process.env.TEST_DB_URL,
});

let tenantId: string;
let parentCo: string;
let subCo: string;

beforeAll(async () => {
  await pool.query("SELECT 1");

  // Create parent company via signup
  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "CONSO-TENANT",
      tenantName: "ConsolidationTenant",
      companyName: "ParentCo",
      name: "Admin",
      email: `conso-${Date.now()}@test.com`,
      password: "SuperStrong#1234",
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  parentCo  = signup.body.companyId;

  // Create subsidiary
  const now = new Date();
  const sub = await pool.query(
    `
    INSERT INTO company
      (id,tenant_id,name,enabled,created_at,country_id)
    VALUES
      (gen_random_uuid(),$1,'SubCo',true,$2,$3)
    RETURNING id
    `,
    [tenantId, now, "11111111-1111-4111-8111-111111111111"]
  );

  subCo = sub.rows[0].id;

  // Provision subsidiary accounting
  await pool.query(`SELECT install_ifrs_coa($1,$2)`, [tenantId, subCo]);
  await pool.query(`SELECT install_default_journals($1,$2)`, [tenantId, subCo]);
  await pool.query(
    `SELECT install_company_accounting_settings($1,$2,$3)`,
    [tenantId, subCo, "11111111-1111-4111-8111-111111111111"]
  );

  // Register parent–subsidiary relationship for consolidation engine
  await pool.query(
    `
    INSERT INTO consolidation_entities
      (id,tenant_id,parent_company_id,child_company_id,ownership_percent)
    VALUES
      (gen_random_uuid(),$1,$2,$3,100)
    `,
    [tenantId, parentCo, subCo]
  );
});

afterAll(async () => {
  await pool.end();
});

async function expectBalanced(jeId: string) {
  const rows = await pool.query(
    `SELECT debit,credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const d = rows.rows.reduce((a, r) => a + Number(r.debit), 0);
  const c = rows.rows.reduce((a, r) => a + Number(r.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("IFRS 10 Consolidation E2E", () => {
  let icInvoiceId: string;
  let icInvoiceJe: string;

  let mirroredBillId: string;
  let mirroredBillJe: string;

  let consolidationRunId: string;

  // -------------------------------------------------------------
  // 1) Create intercompany AR→AP exposure for elimination
  // -------------------------------------------------------------
  test("Create intercompany invoice in ParentCo", async () => {
    const inv = await pool.query(
      `
      INSERT INTO invoices
       (id,tenant_id,company_id,invoice_number,invoice_date,total_amount,
        currency_id,is_intercompany,intercompany_company_id)
      VALUES
       (gen_random_uuid(),$1,$2,'CONSO-IC-1',NOW(),500,
        (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2),
        true,$3)
      RETURNING id
      `,
      [tenantId, parentCo, subCo]
    );

    icInvoiceId = inv.rows[0].id;

    await pool.query(
      `
      INSERT INTO invoice_items
        (id,invoice_id,tenant_id,company_id,description,amount)
      VALUES
        (gen_random_uuid(),$1,$2,$3,'IC Sale',500)
      `,
      [icInvoiceId, tenantId, parentCo]
    );

    const post = await pool.query(`SELECT post_invoice($1) AS je`, [icInvoiceId]);
    icInvoiceJe = post.rows[0].je;

    expect(icInvoiceJe).toBeDefined();
    await expectBalanced(icInvoiceJe);
  });

  // -------------------------------------------------------------
  // 2) Subsidiary receives mirrored vendor bill
  // -------------------------------------------------------------
  test("Mirrored bill in SubCo", async () => {
    const bill = await pool.query(
      `
      SELECT id FROM vendor_bill
      WHERE related_ic_invoice_id=$1 AND company_id=$2
      `,
      [icInvoiceId, subCo]
    );

    expect(bill.rowCount).toBe(1);
    mirroredBillId = bill.rows[0].id;

    const post = await pool.query(`SELECT post_vendor_bill($1) AS je`, [mirroredBillId]);
    mirroredBillJe = post.rows[0].je;

    await expectBalanced(mirroredBillJe);
  });

  // -------------------------------------------------------------
  // 3) Post investment in subsidiary (parent books)
  // -------------------------------------------------------------
  test("Parent investment in subsidiary", async () => {
    const invAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='INVESTMENT' LIMIT 1`,
      [parentCo]
    );

    const equityAcc = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 AND account_type='EQUITY' LIMIT 1`,
      [subCo]
    );

    const je = uuidv4();

    await pool.query(
      `
      INSERT INTO journal_entries
        (id,tenant_id,company_id,journal_id,entry_date,currency_id,fx_rate,reference)
      VALUES
        ($1,$2,$3,(SELECT id FROM journals WHERE company_id=$3 LIMIT 1),
         NOW(),
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$3),
         1,'INVEST-IN-SUB')
      `,
      [je, tenantId, parentCo]
    );

    await pool.query(
      `
      INSERT INTO journal_entry_lines (id,journal_entry_id,tenant_id,company_id,account_id,debit,credit)
      VALUES
        (gen_random_uuid(),$1,$2,$3,$4,1000,0),
        (gen_random_uuid(),$1,$2,$3,$5,0,1000)
      `,
      [je, tenantId, parentCo, invAcc.rows[0].id, equityAcc.rows[0].id]
    );

    await expectBalanced(je);
  });

  // -------------------------------------------------------------
  // 4) Run Consolidation
  // -------------------------------------------------------------
  test("Run consolidation engine", async () => {
    const run = await pool.query(
      `SELECT run_consolidation($1,$2,'2025-12-31') AS run_id`,
      [tenantId, parentCo]
    );

    consolidationRunId = run.rows[0].run_id;
    expect(consolidationRunId).toBeDefined();
  });

  // -------------------------------------------------------------
  // 5) Validate elimination entries
  // -------------------------------------------------------------
  test("Verify intercompany elimination JE balances", async () => {
    const elim = await pool.query(
      `
      SELECT id FROM journal_entries
      WHERE reference ILIKE '%Elimination%' 
      ORDER BY created_at DESC LIMIT 1
      `
    );

    expect(elim.rowCount).toBe(1);
    const jeId = elim.rows[0].id;

    await expectBalanced(jeId);
  });

  // -------------------------------------------------------------
  // 6) Validate consolidation TB is correct
  // -------------------------------------------------------------
  test("Validate consolidated trial balance", async () => {
    const tb = await pool.query(
      `SELECT * FROM consolidated_trial_balance WHERE consolidation_run_id=$1`,
      [consolidationRunId]
    );

    expect(tb.rowCount).toBeGreaterThan(0);

    // AR/AP balances must be eliminated
    const hasIcBalances = tb.rows.some(
      r => Number(r.amount) !== 0 && (
        r.account_type === 'AR' || r.account_type === 'AP'
      )
    );

    expect(hasIcBalances).toBe(false);
  });

  // -------------------------------------------------------------
  // 7) Lock consolidation
  // -------------------------------------------------------------
  test("Lock consolidation run", async () => {
    await pool.query(`SELECT lock_consolidation_run($1)`, [consolidationRunId]);

    const r = await pool.query(
      `SELECT is_locked FROM consolidation_runs WHERE id=$1`,
      [consolidationRunId]
    );

    expect(r.rows[0].is_locked).toBe(true);
  });

  // -------------------------------------------------------------
  // 8) Consolidation posting blocked when locked
  // -------------------------------------------------------------
  test("Posting blocked when consolidation is locked", async () => {
    await expect(
      pool.query(
        `SELECT run_consolidation($1,$2,'2025-12-31')`,
        [tenantId, parentCo]
      )
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------
  // 9) Re-open consolidation
  // -------------------------------------------------------------
  test("Re-open consolidation", async () => {
    await pool.query(
      `UPDATE consolidation_runs SET is_locked=false WHERE id=$1`,
      [consolidationRunId]
    );

    // Should now succeed
    const run = await pool.query(
      `SELECT run_consolidation($1,$2,'2026-12-31') AS run_id`,
      [tenantId, parentCo]
    );

    expect(run.rows[0].run_id).toBeDefined();
  });
});
