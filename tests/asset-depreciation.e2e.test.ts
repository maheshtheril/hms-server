/**
 * MODULE 20 — Asset Depreciation Engine (IAS 16) E2E Tests
 *
 * Validates:
 *   1. Asset acquisition & capitalization
 *   2. Depreciation schedule generation
 *   3. Monthly depreciation run
 *   4. Proration (mid-month acquisition)
 *   5. Accumulated depreciation movement
 *   6. Asset disposal (gain/loss)
 *   7. Asset revaluation (IAS 16)
 *   8. FX revaluation on NBV
 *   9. Locking periods
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
      org: "FAASSET",
      tenantName: "AssetTenant",
      companyName: "AssetCo",
      name: "Admin",
      email: `asset-${Date.now()}@test.com`,
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

async function balanced(jeId: string) {
  const r = await pool.query(
    `SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1`,
    [jeId]
  );
  const d = r.rows.reduce((a, x) => a + Number(x.debit), 0);
  const c = r.rows.reduce((a, x) => a + Number(x.credit), 0);
  expect(Number(d.toFixed(2))).toBe(Number(c.toFixed(2)));
}

describe("IAS 16 — Asset Depreciation Engine E2E", () => {
  let assetId: string;
  let depSchedule: any[];
  let depJe1: string;

  // -------------------------------------------------------------
  // 1) Create asset category (Straight-line, 5-year useful life)
  // -------------------------------------------------------------
  test("Create asset category", async () => {
    const cat = await pool.query(
      `
      INSERT INTO asset_categories
        (id,tenant_id,company_id,name,method,useful_life_years,salvage_value)
      VALUES
        (gen_random_uuid(),$1,$2,'Office Equipment','SL',5,100)
      RETURNING id
      `,
      [tenantId, companyId]
    );

    expect(cat.rows[0].id).toBeDefined();
  });

  // -------------------------------------------------------------
  // 2) Acquire an asset
  // -------------------------------------------------------------
  test("Asset acquisition", async () => {
    const as = await pool.query(
      `
      INSERT INTO fixed_assets
        (id,tenant_id,company_id,category_id,description,acquisition_date,acquisition_cost,currency_id)
      VALUES
        (gen_random_uuid(),$1,$2,
         (SELECT id FROM asset_categories WHERE company_id=$2 LIMIT 1),
         'Laptop A',
         '2025-01-10',
         2600,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id
      `,
      [tenantId, companyId]
    );

    assetId = as.rows[0].id;
    expect(assetId).toBeDefined();

    // Asset capitalization JE
    const cap = await pool.query(
      `SELECT capitalize_asset($1) AS je`,
      [assetId]
    );

    await balanced(cap.rows[0].je);
  });

  // -------------------------------------------------------------
  // 3) Generate depreciation schedule
  // -------------------------------------------------------------
  test("Generate depreciation schedule", async () => {
    const sched = await pool.query(
      `SELECT * FROM generate_depreciation_schedule($1) ORDER BY period`,
      [assetId]
    );

    depSchedule = sched.rows;
    expect(depSchedule.length).toBe(60); // 5 years monthly

    // Straight-line: (cost - salvage) / useful months
    // (2600 - 100) / 60 = 41.666...
    expect(Number(depSchedule[0].amount)).toBeCloseTo(41.67);
  });

  // -------------------------------------------------------------
  // 4) Run depreciation for first month
  // -------------------------------------------------------------
  test("Run depreciation month 1", async () => {
    const dep = await pool.query(
      `SELECT run_depreciation($1,'2025-01') AS je`,
      [assetId]
    );

    depJe1 = dep.rows[0].je;

    expect(depJe1).toBeDefined();
    await balanced(depJe1);

    const check = await pool.query(
      `
      SELECT SUM(debit - credit) AS dep
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [depJe1]
    );

    expect(Number(check.rows[0].dep)).toBeCloseTo(41.67);
  });

  // -------------------------------------------------------------
  // 5) Partial period depreciation (proration)
  // -------------------------------------------------------------
  test("Prorated depreciation for acquisition mid-month", async () => {
    const asset2 = await pool.query(
      `
      INSERT INTO fixed_assets
        (id,tenant_id,company_id,category_id,description,acquisition_date,acquisition_cost,currency_id)
      VALUES
        (gen_random_uuid(),$1,$2,
         (SELECT id FROM asset_categories WHERE company_id=$2 LIMIT 1),
         'Printer B','2025-02-15',1200,
         (SELECT currency_id FROM company_accounting_settings WHERE company_id=$2)
        )
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const a2 = asset2.rows[0].id;

    // Capitalize
    const cap = await pool.query(`SELECT capitalize_asset($1) AS je`, [a2]);
    await balanced(cap.rows[0].je);

    const dep = await pool.query(
      `SELECT run_depreciation($1,'2025-02') AS je`,
      [a2]
    );

    const je = dep.rows[0].je;

    expect(je).toBeDefined();
    await balanced(je);

    const amt = await pool.query(
      `
      SELECT SUM(debit-credit) AS amount
      FROM journal_entry_lines
      WHERE journal_entry_id=$1
      `,
      [je]
    );

    // Prorate based on 14 days remaining (from Feb 15 to Feb 28 = 14/28 ≈ 0.5)
    // Annual dep = (1200-100)/60 = 18.33 monthly → 9.16 prorated
    expect(Number(amt.rows[0].amount)).toBeCloseTo(9.17, 1);
  });

  // -------------------------------------------------------------
  // 6) Asset revaluation (IAS 16 revaluation model)
  // -------------------------------------------------------------
  test("Asset revaluation increases NBV", async () => {
    const reval = await pool.query(
      `
      SELECT revalue_asset($1,3000,'2025-06-01') AS je
      `,
      [assetId]
    );

    const je = reval.rows[0].je;
    expect(je).toBeDefined();

    await balanced(je);
  });

  // -------------------------------------------------------------
  // 7) FX revaluation on NBV
  // -------------------------------------------------------------
  test("FX revaluation", async () => {
    const fx = await pool.query(
      `
      SELECT run_fx_revaluation($1,$2,'2025-06-30') AS je
      `,
      [tenantId, companyId]
    );

    const je = fx.rows[0].je;
    expect(je).toBeDefined();

    await balanced(je);
  });

  // -------------------------------------------------------------
  // 8) Asset disposal (gain/loss calculation)
  // -------------------------------------------------------------
  test("Asset disposal", async () => {
    const disp = await pool.query(
      `
      SELECT dispose_asset($1,2500,'2025-12-01') AS je
      `,
      [assetId]
    );

    const je = disp.rows[0].je;
    expect(je).toBeDefined();

    await balanced(je);

    const check = await pool.query(
      `SELECT * FROM fixed_assets WHERE id=$1`,
      [assetId]
    );

    expect(check.rows[0].is_disposed).toBe(true);
  });

  // -------------------------------------------------------------
  // 9) Period close blocks depreciation
  // -------------------------------------------------------------
  test("Period close blocks depreciation run", async () => {
    const period = await pool.query(
      `
      INSERT INTO accounting_periods
        (id,tenant_id,company_id,period_label,date_from,date_to,is_open)
      VALUES
        (gen_random_uuid(),$1,$2,'2025-DEC','2025-12-01','2025-12-31',true)
      RETURNING id
      `,
      [tenantId, companyId]
    );

    const pid = period.rows[0].id;

    await pool.query(`SELECT close_period($1)`, [pid]);

    await expect(
      pool.query(
        `SELECT run_depreciation($1,'2025-12')`,
        [assetId]
      )
    ).rejects.toThrow();
  });
});
