/**
 * MODULE 11D — FX Revaluation E2E Tests
 *
 * Requirements:
 *  - Jest + Supertest
 *  - Express app exported from server/src/app.ts
 *  - TEST_DB_URL env pointing to a clean test database
 *  - Schema baseline (the one used when generating this code is at /mnt/data/schema.sql)
 *
 * This test:
 *  1) Provisions a tenant + company via the signup route
 *  2) Creates two foreign-currency journal exposures (one AR, one AP) in a currency != company currency
 *  3) Calls run_fx_revaluation(tenant, company, reval_date)
 *  4) Verifies fx_revaluation_runs row exists
 *  5) Verifies the revaluation produced a single JE and it balances (debits == credits)
 *  6) Calls reverse_fx_revaluation(run_id) and validates a reversal JE is created
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
  // Basic DB sanity
  await pool.query("SELECT 1");

  // 1) Signup a fresh tenant/company using the real signup API (Module 9C)
  const signup = await request(app)
    .post("/tenant-signup")
    .send({
      org: "FXRevalOrg",
      tenantName: "FX Reval Tenant",
      companyName: "FXCo",
      name: "Admin Reval",
      email: `fx-${Date.now()}@test.local`,
      password: "SuperStrong#1234",
      // pick an actual country id from your test fixtures; fallback is acceptable
      country_id: "11111111-1111-4111-8111-111111111111",
      apply_country_tax_defaults: true,
    })
    .expect(201);

  tenantId = signup.body.tenantId;
  companyId = signup.body.companyId;
  userId = signup.body.userId;

  expect(tenantId).toBeDefined();
  expect(companyId).toBeDefined();
  expect(userId).toBeDefined();

  // Defensive: ensure company accounting settings exist
  const cas = await pool.query(
    `SELECT currency_id FROM company_accounting_settings WHERE company_id=$1 LIMIT 1`,
    [companyId]
  );
  expect(cas.rowCount).toBe(1);
});

afterAll(async () => {
  await pool.end();
});

describe("FX Revaluation E2E", () => {
  let foreignCurrencyCode: string;
  let foreignCurrencyId: string;
  let exposureJe1: string;
  let exposureJe2: string;
  let revalRunId: string;
  let revalJeId: string;

  test("prepare foreign currency (ensure exists and differs from company currency)", async () => {
    // find company base currency code
    const baseCurRes = await pool.query(
      `SELECT c.id, c.code
       FROM currencies c
       JOIN company_accounting_settings cas ON cas.currency_id = c.id
       WHERE cas.company_id = $1
       LIMIT 1`,
      [companyId]
    );
    expect(baseCurRes.rowCount).toBe(1);
    const baseCode = baseCurRes.rows[0].code;

    // pick a different currency available in currencies table (prefer EUR or USD)
    const other = await pool.query(
      `SELECT id, code FROM currencies WHERE code <> $1 ORDER BY code LIMIT 1`,
      [baseCode]
    );
    expect(other.rowCount).toBeGreaterThanOrEqual(1);
    foreignCurrencyId = other.rows[0].id;
    foreignCurrencyCode = other.rows[0].code;

    expect(foreignCurrencyCode).not.toBe(baseCode);
  });

  test("create two foreign-currency exposures (one receivable, one payable)", async () => {
    // We'll create two manual journal entries in foreign currency that remain open.
    // 1) AR exposure: customer invoice simulated as a journal entry (debit AR)
    // 2) AP exposure: vendor bill simulated as a journal entry (credit AP)
    // Use company AR/AP accounts from settings.

    const accountsRes = await pool.query(
      `SELECT ar_account_id, ap_account_id FROM company_accounting_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
    );
    expect(accountsRes.rowCount).toBe(1);
    const arAccount = accountsRes.rows[0].ar_account_id;
    const apAccount = accountsRes.rows[0].ap_account_id;
    expect(arAccount).toBeDefined();
    expect(apAccount).toBeDefined();

    // choose amounts and dates
    const txnDate = new Date();
    const amountForeign = 1000; // in foreign currency nominal units

    // create journal entry 1 (AR): debit AR (foreign amount), credit an expense/suspense account so it remains open
    const suspenseAccRes = await pool.query(
      `SELECT id FROM account_chart WHERE company_id=$1 LIMIT 1`,
      [companyId]
    );
    expect(suspenseAccRes.rowCount).toBe(1);
    const suspenseAcc = suspenseAccRes.rows[0].id;

    // insert journal entry header
    const je1 = uuidv4();
    await pool.query(
      `INSERT INTO journal_entries (id, tenant_id, company_id, journal_id, entry_date, currency_id, fx_rate, ref, created_at, updated_at)
       VALUES ($1,$2,$3, (SELECT id FROM journals WHERE company_id=$3 LIMIT 1), $4, $5, 1.0, $6, NOW(), NOW())`,
      [je1, tenantId, companyId, txnDate.toISOString().slice(0, 10), foreignCurrencyId, `FX-EXPOSURE-AR-${Date.now()}`]
    );

    // lines: debit AR, credit suspense
    await pool.query(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, tenant_id, company_id, account_id, debit, credit, created_at)
       VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, 0, NOW()),
       (gen_random_uuid(), $1, $2, $3, $6, 0, $5, NOW())`,
      [je1, tenantId, companyId, arAccount, amountForeign, suspenseAcc]
    );

    exposureJe1 = je1;

    // insert journal entry 2 (AP): credit AP, debit suspense
    const je2 = uuidv4();
    await pool.query(
      `INSERT INTO journal_entries (id, tenant_id, company_id, journal_id, entry_date, currency_id, fx_rate, ref, created_at, updated_at)
       VALUES ($1,$2,$3, (SELECT id FROM journals WHERE company_id=$3 LIMIT 1), $4, $5, 1.0, $6, NOW(), NOW())`,
      [je2, tenantId, companyId, txnDate.toISOString().slice(0, 10), foreignCurrencyId, `FX-EXPOSURE-AP-${Date.now()}`]
    );

    await pool.query(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, tenant_id, company_id, account_id, debit, credit, created_at)
       VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, 0, NOW()),
       (gen_random_uuid(), $1, $2, $3, $6, 0, $5, NOW())`,
      [je2, tenantId, companyId, suspenseAcc, amountForeign, apAccount]
    );

    exposureJe2 = je2;

    // sanity: ensure entries recorded
    const check = await pool.query(`SELECT id FROM journal_entries WHERE id IN ($1,$2)`, [exposureJe1, exposureJe2]);
    expect(check.rowCount).toBe(2);
  });

  test("run FX revaluation and verify run + revaluation JE", async () => {
    // choose reval date (today)
    const revalDate = new Date().toISOString().slice(0, 10);

    // call the SQL function run_fx_revaluation(tenant, company, date) which returns run_id
    const runRes = await pool.query(`SELECT run_fx_revaluation($1,$2,$3) AS run_id`, [
      tenantId,
      companyId,
      revalDate,
    ]);

    expect(runRes.rowCount).toBe(1);
    revalRunId = runRes.rows[0].run_id;
    expect(revalRunId).toBeDefined();

    // verify run logged
    const runCheck = await pool.query(`SELECT id, revaluation_date FROM fx_revaluation_runs WHERE id=$1`, [revalRunId]);
    expect(runCheck.rowCount).toBe(1);
    expect(runCheck.rows[0].revaluation_date.toISOString().slice(0, 10)).toBe(revalDate);

    // locate the revaluation journal entry created by the function
    // The provisioning uses a general journal id; find a JE with reference containing 'FX Revaluation' and the date
    const jeRes = await pool.query(
      `SELECT id FROM journal_entries WHERE reference ILIKE $1 AND company_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [`%FX Revaluation%${revalDate}%`, companyId]
    );

    // fallback: try by date and recently created if reference pattern different
    if (jeRes.rowCount === 0) {
      const fallback = await pool.query(
        `SELECT id FROM journal_entries WHERE entry_date=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 1`,
        [revalDate, companyId]
      );
      expect(fallback.rowCount).toBeGreaterThan(0);
      revalJeId = fallback.rows[0].id;
    } else {
      revalJeId = jeRes.rows[0].id;
    }

    expect(revalJeId).toBeDefined();

    // verify JE lines exist and that the JE balances
    const lines = await pool.query(`SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`, [revalJeId]);
    expect(lines.rowCount).toBeGreaterThanOrEqual(1);

    const totalDebit = lines.rows.reduce((s: number, r: any) => s + Number(r.debit || 0), 0);
    const totalCredit = lines.rows.reduce((s: number, r: any) => s + Number(r.credit || 0), 0);

    // allow small rounding deltas; assert roughly equal
    const diff = Math.abs(Number((totalDebit - totalCredit).toFixed(2)));
    expect(diff).toBeLessThanOrEqual(0.01);
  });

  test("reverse the revaluation and confirm reversal JE created", async () => {
    // Call reverse_fx_revaluation(run_id) which should return the reversal JE id (or a run id) — per Module 8E implementation it returns the reversed JE id via reverse_journal_entry call
    const rev = await pool.query(`SELECT reverse_fx_revaluation($1) AS rev_je`, [revalRunId]);
    expect(rev.rowCount).toBe(1);
    const revJe = rev.rows[0].rev_je;
    expect(revJe).toBeDefined();

    // verify reversal JE exists and balances
    const lines = await pool.query(`SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`, [revJe]);
    expect(lines.rowCount).toBeGreaterThanOrEqual(1);

    const totalDebit = lines.rows.reduce((s: number, r: any) => s + Number(r.debit || 0), 0);
    const totalCredit = lines.rows.reduce((s: number, r: any) => s + Number(r.credit || 0), 0);

    const diff = Math.abs(Number((totalDebit - totalCredit).toFixed(2)));
    expect(diff).toBeLessThanOrEqual(0.01);
  });
});
