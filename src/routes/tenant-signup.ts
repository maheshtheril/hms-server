// server/src/routes/tenant-signup.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { provisionTenantRBAC } from "../services/provisionTenant";
import type { PoolClient } from "pg";

const router = Router();

/* ───────────────── Password policy ───────────────── */
const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  symbolRegex: /[^A-Za-z0-9]/,
};

function checkPassword(pw: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof pw !== "string" || !pw.trim()) reasons.push("Password is required.");
  if (pw.length < PASSWORD_POLICY.minLength) reasons.push(`Minimum ${PASSWORD_POLICY.minLength} characters.`);
  if (pw.length > PASSWORD_POLICY.maxLength) reasons.push(`Maximum ${PASSWORD_POLICY.maxLength} characters.`);
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(pw)) reasons.push("Include at least one uppercase letter.");
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(pw)) reasons.push("Include at least one lowercase letter.");
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw)) reasons.push("Include at least one number.");
  if (PASSWORD_POLICY.requireSymbol && !PASSWORD_POLICY.symbolRegex.test(pw)) reasons.push("Include at least one symbol.");
  return { ok: reasons.length === 0, reasons };
}

/* ───────────────── Helpers ───────────────── */
function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function listColumns(cx: PoolClient, table: string): Promise<Set<string>> {
  const r = await cx.query(
    `SELECT LOWER(column_name) AS column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map((x: any) => String(x.column_name)));
}

function buildInsert(tableQ: string, colsAvail: Set<string>, wanted: Record<string, any>) {
  const cols: string[] = [];
  const vals: any[] = [];
  const ph: string[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(wanted)) {
    if (colsAvail.has(k)) {
      cols.push(k);
      vals.push(v);
      ph.push(`$${i++}`);
    }
  }
  if (!cols.length) throw new Error(`No matching columns to insert for ${tableQ}`);
  return { text: `INSERT INTO ${tableQ} (${cols.join(",")}) VALUES (${ph.join(",")})`, values: vals };
}

/* ───────────────── SIGNUP: tenant + company + owner user ─────────────────
 * Body (strings):
 *   org, tenantName, company, companyName, name, email, password
 */
router.post("/", async (req, res) => {
  const {
    org,
    tenantName,   // alias (optional)
    company,
    companyName,  // alias (optional)
    name,
    email,
    password,
  } = req.body || {};

  const tenant_name = String(tenantName || org || "").trim();
  const company_name = String(companyName || company || tenant_name || "").trim();
  const user_name = String(name || "").trim();
  const email_lc = String(email || "").trim().toLowerCase();

  // Validate presence
  if (!tenant_name || !company_name || !user_name || !email_lc || !password) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      fields: {
        org: !!tenant_name,
        company: !!company_name,
        name: !!user_name,
        email: !!email_lc,
        password: !!password,
      },
    });
  }
  // Validate email format
  if (!/^\S+@\S+\.\S+$/.test(email_lc)) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  // Validate password complexity
  const pw = checkPassword(String(password));
  if (!pw.ok) {
    return res.status(400).json({ ok: false, error: "weak_password", reasons: pw.reasons });
  }

  const tenantId = randomUUID();
  const companyId = randomUUID();
  const userId = randomUUID();
  const now = new Date();
  const baseSlug = slugify(tenant_name) || `org-${tenantId.slice(0, 8)}`;

  const cx: PoolClient = await pool.connect();
  let began = false;

  try {
    // Discover columns
    const tenantCols = await listColumns(cx, "tenant");
    const companyCols = await listColumns(cx, "company");
    const userCols    = await listColumns(cx, "app_user");
    const mapCols     = await listColumns(cx, "user_companies").catch(() => new Set<string>());

    // REQUIRED columns
    for (const c of ["id", "slug", "name"]) {
      if (!tenantCols.has(c)) {
        return res.status(500).json({ ok: false, error: "schema_mismatch", hint: `tenant.${c} missing` });
      }
    }
    for (const c of ["id", "tenant_id", "name"]) {
      if (!companyCols.has(c)) {
        return res.status(500).json({ ok: false, error: "schema_mismatch", hint: `company.${c} missing` });
      }
    }
    for (const c of ["id", "tenant_id", "email"]) {
      if (!userCols.has(c)) {
        return res.status(500).json({ ok: false, error: "schema_mismatch", hint: `app_user.${c} missing` });
      }
    }

    // pre-check existing email
    const e = await cx.query(`SELECT id FROM public.app_user WHERE email=$1 LIMIT 1`, [email_lc]);
    if (e.rowCount) {
      return res.status(409).json({ ok: false, error: "email_exists", user_id: e.rows[0].id });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    await cx.query("BEGIN");
    began = true;

    /* ─ Tenant ─ */
    const tenantWanted: Record<string, any> = {
      id: tenantId,
      slug: baseSlug,
      name: tenant_name,
      created_at: now,
    };
    let insertedTenant = false;
    for (let i = 0; i < 8 && !insertedTenant; i++) {
      const candidate = i === 0 ? tenantWanted : { ...tenantWanted, slug: `${baseSlug}-${i + 1}` };
      const ins = buildInsert("public.tenant", tenantCols, candidate);
      try {
        await cx.query(ins.text, ins.values);
        insertedTenant = true;
      } catch (err: any) {
        if (err?.code === "23505") continue; // unique violation on slug -> try next
        throw err;
      }
    }
    if (!insertedTenant) throw new Error("Could not create unique tenant.slug after retries");

    /* ─ Company ─ */
    const companyWanted: Record<string, any> = {
      id: companyId,
      tenant_id: tenantId,
      name: company_name,
      enabled: true,        // kept if column exists; buildInsert filters safely
      created_at: now,
    };
    const companyIns = buildInsert("public.company", companyCols, companyWanted);
    await cx.query(companyIns.text, companyIns.values);

    /* ─ User (owner/admin) ─ */
    const userWanted: Record<string, any> = {
      id: userId,
      tenant_id: tenantId,
      email: email_lc,
      name: user_name,
      password: passwordHash,      // your schema uses "password"
      is_admin: true,              // optional flags in your schema
      is_tenant_admin: true,
      is_active: true,
      created_at: now,
    };
    if (userCols.has("company_id")) userWanted["company_id"] = companyId;

    const userIns = buildInsert("public.app_user", userCols, userWanted);
    await cx.query(userIns.text, userIns.values);

    /* ─ Mapping (user_companies) ─ */
    if (mapCols.size > 0) {
      const mapWanted: Record<string, any> = {
        tenant_id: tenantId,
        user_id: userId,
        company_id: companyId,
        is_default: true,
        created_at: now,
      };
      const mapIns = buildInsert("public.user_companies", mapCols, mapWanted);
      try {
        await cx.query(mapIns.text, mapIns.values);
      } catch (err: any) {
        if (err?.code !== "23505") throw err; // ignore duplicate default
      }
    }

    await cx.query("COMMIT");
    began = false;

    // ─ RBAC provision (non-blocking), pass the SAME client to satisfy PoolClient type
    try {
      await provisionTenantRBAC(cx, { tenantId, ownerUserId: userId });
    } catch (e) {
      console.error("[tenant-signup] RBAC", e);
    }

    return res.status(201).json({ ok: true, tenantId, companyId, userId });
  } catch (err: any) {
    if (began) {
      try { await cx.query("ROLLBACK"); } catch {}
    }
    console.error("[tenant-signup] error:", {
      message: err?.message, code: err?.code, detail: err?.detail, constraint: err?.constraint
    });

    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, error: "unique_violation", detail: err?.detail, constraint: err?.constraint });
    }
    if (err?.message?.includes("No matching columns to insert")) {
      return res.status(500).json({ ok: false, error: "schema_mismatch", hint: err?.message });
    }
    return res.status(500).json({ ok: false, error: "signup_failed" });
  } finally {
    cx.release();
  }
});

export default router;
