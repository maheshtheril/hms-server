// server/src/routes/api/auth/signup.ts
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../../../db";
import { createSession } from "../../../lib/session";
import { COOKIE_NAME, SESSION_TTL_SECONDS } from "../../../lib/session";

// 🔥 RATE LIMITER DISABLED
// import rateLimitSignup from "../../../middleware/rateLimitSignup";

import domainTenantPolicy from "../../../lib/domainTenantPolicy";
import { createVerificationToken, sendVerificationEmail } from "../../../lib/emailVerification";

const router = Router();

console.info("[signup.ts] module loaded");

/* ------------------------------- */
async function q(client: any, text: string, params: any[] = []) {
  try {
    return await client.query(text, params);
  } catch (err: any) {
    console.error("[pg][query_error]", text, params, JSON.stringify(err, Object.getOwnPropertyNames(err)));
    throw err;
  }
}

/* ---------------- Password Policy ---------------- */
const PASSWORD_POLICY = {
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  regexSymbol: /[^A-Za-z0-9]/,
};

function checkPassword(pw: any): string[] {
  const r: string[] = [];
  if (!pw) return ["Password is required."];
  if (pw.length < PASSWORD_POLICY.minLength) r.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters.`);
  if (!/[A-Z]/.test(pw)) r.push("At least one uppercase required.");
  if (!/[a-z]/.test(pw)) r.push("At least one lowercase required.");
  if (!/[0-9]/.test(pw)) r.push("At least one number required.");
  if (!PASSWORD_POLICY.regexSymbol.test(pw)) r.push("At least one special symbol required.");
  return r;
}

/* ---------------- Slugify ---------------- */
function slugifyBase(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ---------------- Unique Slug Insert ---------------- */
async function tryInsertTenantWithUniqueSlug(client: any, baseSlug: string, name: string) {
  for (let i = 0; i < 7; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    try {
      const r = await q(client, `INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id`, [candidate, name]);
      return { id: r.rows[0].id, slug: candidate };
    } catch (err: any) {
      if (err.code === "23505") continue;
      throw err;
    }
  }
  throw new Error("Unable to create unique tenant slug");
}

/* ---------------- Country Resolve ---------------- */
const isUuid = (s: any) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function resolveCountryUUID(client: any, countryId: string): Promise<string> {
  if (isUuid(countryId)) return countryId;

  const qVal = String(countryId).trim().toUpperCase();
  const r = await q(
    client,
    `SELECT id FROM countries WHERE UPPER(TRIM(iso2))=$1 OR UPPER(TRIM(iso3))=$1 OR UPPER(TRIM(name))=$1 LIMIT 1`,
    [qVal]
  );
  if (r.rowCount > 0) return r.rows[0].id;

  throw new Error(`Invalid countryId: ${countryId}`);
}

/* ---------------- Currency Resolve ---------------- */
async function resolveCurrencyForCountry(client: any, countryId: string): Promise<string | null> {
  const mapped = await q(
    client,
    `SELECT cur.id
     FROM country_default_currency cdc
     JOIN currencies cur ON cur.id = cdc.currency_id
     WHERE cdc.country_id = $1 AND cdc.is_active=true AND cur.is_active=true
     ORDER BY cdc.created_at DESC LIMIT 1`,
    [countryId]
  );
  if (mapped.rowCount > 0) return mapped.rows[0].id;

  const prefer = await q(
    client,
    `SELECT id FROM currencies WHERE is_active=true AND code IN ('USD','EUR') 
     ORDER BY CASE WHEN code='USD' THEN 0 WHEN code='EUR' THEN 1 END LIMIT 1`
  );
  if (prefer.rowCount > 0) return prefer.rows[0].id;

  const any = await q(client, `SELECT id FROM currencies WHERE is_active=true LIMIT 1`);
  return any.rowCount > 0 ? any.rows[0].id : null;
}

/* ============================================================
   SIGNUP HANDLER
============================================================ */
export async function signupHandler(req: Request, res: Response) {
  console.info("[signup] invoked");

  let client: any;

  try {
    // 🔥 RATE LIMITER DISABLED — ALWAYS ALLOW
    // const rl = await rateLimitSignup(req);

    /* ---------------- Parse Input ---------------- */
    const { name, email, password, company, countryId, industry } = req.body || {};

    if (!name || !email || !password || !company || !countryId)
      return res.status(400).json({ error: "missing_fields" });

    const emailLC = String(email).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(emailLC))
      return res.status(400).json({ error: "invalid_email" });

    const pwErr = checkPassword(password);
    if (pwErr.length) return res.status(400).json({ error: "weak_password", reasons: pwErr });

    const dp = await domainTenantPolicy(emailLC).catch(() => null);
    if (dp && !dp.ok) return res.status(dp.status ?? 403).json({ error: dp.error });

    client = await pool.connect();

    /* ---------------- Check Email Exists ---------------- */
    const ex = await q(client, `SELECT id FROM app_user WHERE LOWER(email)=LOWER($1) LIMIT 1`, [emailLC]);
    if (ex.rowCount > 0) return res.status(409).json({ error: "email_exists" });

    const hash = await bcrypt.hash(password, 12);

    let tenantId: string;
    let companyId: string;
    let userId: string;

    /* ---------------- Transaction ---------------- */
    try {
      await q(client, "BEGIN");

      const baseSlug = slugifyBase(company) || `org-${Math.random().toString(36).slice(2)}`;
      const t = await tryInsertTenantWithUniqueSlug(client, baseSlug, company);
      tenantId = t.id;

      const resolvedCountryId = await resolveCountryUUID(client, countryId);

      const c = await q(
        client,
        `INSERT INTO company (tenant_id, name, country_id)
         VALUES ($1,$2,$3) RETURNING id`,
        [tenantId, company, resolvedCountryId]
      );
      companyId = c.rows[0].id;

      if (industry)
        await q(client, `UPDATE company SET industry=$1 WHERE id=$2`, [industry, companyId]);

      const currencyId = await resolveCurrencyForCountry(client, resolvedCountryId);
      if (!currencyId) {
        await q(client, "ROLLBACK").catch(() => {});
        return res.status(500).json({
          error: "no_currency_available",
          message: "Seed currencies and country_default_currency first.",
        });
      }

      await q(
        client,
        `INSERT INTO company_settings (
            id, tenant_id, company_id, currency_id,
            default_tax_type_id, default_tax_rate_id,
            rounding_precision, numbering_prefix, numbering_next,
            address_country_id, auto_load_taxes_from_country,
            created_at, updated_at
        ) VALUES (
            gen_random_uuid(), $1, $2, $3,
            NULL, NULL,
            2, 'INV', 1,
            $4, true,
            now(), now()
        ) ON CONFLICT (company_id) DO NOTHING`,
        [tenantId, companyId, currencyId, resolvedCountryId]
      );

      const u = await q(
        client,
        `INSERT INTO app_user
         (tenant_id, company_id, email, name, password, is_tenant_admin, is_active)
         VALUES ($1,$2,$3,$4,$5,true,true)
         RETURNING id`,
        [tenantId, companyId, emailLC, name, hash]
      );
      userId = u.rows[0].id;

      await q(
        client,
        `INSERT INTO user_companies
         (tenant_id, user_id, company_id, is_default, created_at)
         VALUES ($1,$2,$3,true,now())
         ON CONFLICT (tenant_id, user_id, company_id) DO NOTHING`,
        [tenantId, userId, companyId]
      );

      await q(client, "COMMIT");
    } catch (err) {
      await q(client, "ROLLBACK").catch(() => {});
      console.error("Signup TX error:", err);
      return res.status(500).json({ error: "signup_failed" });
    }

    /* ---------------- Email verification (background) ---------------- */
    (async () => {
      try {
        const token = await createVerificationToken(userId, emailLC);
        await sendVerificationEmail(emailLC, token);
      } catch (_) {}
    })();

    /* ---------------- Session Cookie ---------------- */
    try {
      const sid = await createSession({ userId, tenantId, companyId });
      const cookieName = process.env.SESSION_COOKIE_NAME || COOKIE_NAME;
      const prod = process.env.NODE_ENV === "production";

      res.cookie(cookieName, sid, {
        httpOnly: true,
        secure: prod,
        sameSite: prod ? "none" : "lax",
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: "/",
      });
    } catch (err) {
      console.error("session cookie error:", err);
    }

    return res.status(201).json({
      ok: true,
      tenantId,
      companyId,
      userId,
      redirect: "/tenant/onboarding/hms",
    });
  } catch (err) {
    console.error("[signup] handler error:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    if (client) client.release();
  }
}

router.post("/", signupHandler);
export default router;
