// server/src/routes/api/auth/signup.ts
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../../../db";
import { createSession } from "../../../lib/session";
import { COOKIE_NAME, SESSION_TTL_SECONDS } from "../../../lib/session";
import rateLimitSignup from "../../../middleware/rateLimitSignup";
import domainTenantPolicy from "../../../lib/domainTenantPolicy";
import { createVerificationToken, sendVerificationEmail } from "../../../lib/emailVerification";

const router = Router();

console.info("[signup.ts] module loaded");

/* ---------------------------------------------------------
   PASSWORD POLICY
--------------------------------------------------------- */
const PASSWORD_POLICY = {
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  regexSymbol: /[^A-Za-z0-9]/,
};

function checkPassword(pw: any): string[] {
  const reasons: string[] = [];
  if (typeof pw !== "string" || !pw) {
    reasons.push("Password is required.");
    return reasons;
  }
  if (pw.length < PASSWORD_POLICY.minLength)
    reasons.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters.`);
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(pw)) reasons.push("At least one uppercase letter required.");
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(pw)) reasons.push("At least one lowercase letter required.");
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw)) reasons.push("At least one number required.");
  if (PASSWORD_POLICY.requireSymbol && !PASSWORD_POLICY.regexSymbol.test(pw)) reasons.push("At least one special symbol required.");
  return reasons;
}

/* ---------------------------------------------------------
   CLEAN SLUGIFY
--------------------------------------------------------- */
function slugifyBase(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ---------------------------------------------------------
   TRY INSERT TENANT WITH UNIQUE SLUG
--------------------------------------------------------- */
async function tryInsertTenantWithUniqueSlug(client: any, baseSlug: string, name: string) {
  for (let i = 0; i < 7; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    try {
      const r = await client.query(
        `INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id`,
        [candidate, name]
      );
      return { id: r.rows[0].id, slug: candidate };
    } catch (err: any) {
      if (err.code === "23505") continue; // slug conflict
      throw err;
    }
  }
  throw new Error("Unable to create unique tenant slug");
}

/* ---------------------------------------------------------
   HELPER: Country lookup (your actual table = countries)
--------------------------------------------------------- */
const isUuid = (s: any) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function resolveCountryUUID(client: any, countryId: string): Promise<string> {
  if (isUuid(countryId)) return countryId;

  const qVal = String(countryId).trim().toUpperCase();

  const r = await client.query(
    `
    SELECT id FROM countries
    WHERE UPPER(TRIM(iso2)) = $1
       OR UPPER(TRIM(iso3)) = $1
       OR UPPER(TRIM(name)) = $1
    LIMIT 1
  `,
    [qVal]
  );

  if (r.rowCount > 0) return r.rows[0].id;

  throw new Error(`Invalid countryId: ${countryId}`);
}

/* ============================================================
   SIGNUP HANDLER
============================================================ */
export async function signupHandler(req: Request, res: Response) {
  console.info("[signup] invoked");

  let client: any | null = null;

  try {
    /* ---------------------------------------------------------
       1) RATE LIMIT
    --------------------------------------------------------- */
    const rl = await rateLimitSignup(req);
    if (rl && rl.ok === false) {
      return res.status(429).json({ error: "too_many_attempts", retryAfter: rl.retryAfter });
    }

    /* ---------------------------------------------------------
       2) PARSE INPUT
    --------------------------------------------------------- */
    const { name, email, password, company, countryId, industry } =
      (req as any).body || {};

    if (!name || !email || !password || !company || !countryId) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const emailLC = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(emailLC)) {
      return res.status(400).json({ error: "invalid_email" });
    }

    /* ---------------------------------------------------------
       3) PASSWORD CHECK
    --------------------------------------------------------- */
    const pwErrors = checkPassword(password);
    if (pwErrors.length) {
      return res.status(400).json({ error: "weak_password", reasons: pwErrors });
    }

    /* ---------------------------------------------------------
       4) DOMAIN POLICY
    --------------------------------------------------------- */
    const dPolicy = await domainTenantPolicy(emailLC).catch(() => null);
    if (dPolicy && !dPolicy.ok) {
      return res.status(dPolicy.status ?? 403).json({ error: dPolicy.error });
    }

    /* ---------------------------------------------------------
       5) DB CONNECTION
    --------------------------------------------------------- */
    client = await pool.connect();

    /* ---------------------------------------------------------
       6) PRECHECK: EMAIL EXISTS
    --------------------------------------------------------- */
    const existing = await client.query(
      `SELECT id FROM app_user WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [emailLC]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: "email_exists" });
    }

    /* ---------------------------------------------------------
       7) HASH PASSWORD
    --------------------------------------------------------- */
    const hash = await bcrypt.hash(password, 12);

    /* ---------------------------------------------------------
       8) MAIN TRANSACTION
    --------------------------------------------------------- */
    let tenantId: string;
    let companyId: string;
    let userId: string;

    try {
      await client.query("BEGIN");

      /* ------------------- Tenant ----------------------- */
      const baseSlug = slugifyBase(company) || `org-${Math.random().toString(36).slice(2)}`;
      const tenantRow = await tryInsertTenantWithUniqueSlug(client, baseSlug, company);
      tenantId = tenantRow.id;

      /* ------------------- Country ID Fix --------------- */
      const resolvedCountryId = await resolveCountryUUID(client, countryId);

      /* ------------------- Company ---------------------- */
      const c = await client.query(
        `
        INSERT INTO company (tenant_id, name, country_id)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
        [tenantId, company, resolvedCountryId]
      );
      companyId = c.rows[0].id;

      // Update industry (optional)
      if (industry) {
        await client.query(
          `UPDATE company SET industry = $1 WHERE id = $2`,
          [industry, companyId]
        );
      }

      /* ------------------- User ------------------------- */
      try {
        const u = await client.query(
          `
          INSERT INTO app_user
              (tenant_id, company_id, email, name, password, is_tenant_admin, is_active)
          VALUES ($1, $2, $3, $4, $5, true, true)
          RETURNING id
        `,
          [tenantId, companyId, emailLC, name, hash]
        );
        userId = u.rows[0].id;
      } catch (err: any) {
        if (err.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "email_exists" });
        }
        throw err;
      }

      /* ------------------- USER ↔ COMPANY mapping ------- */
      await client.query(
        `
        INSERT INTO user_companies (tenant_id, user_id, company_id, is_default, created_at)
        VALUES ($1, $2, $3, true, now())
        ON CONFLICT (tenant_id, user_id, company_id) DO NOTHING
      `,
        [tenantId, userId, companyId]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Signup TX error:", err);
      return res.status(500).json({ error: "signup_failed" });
    }

    /* ---------------------------------------------------------
       9) EMAIL VERIFICATION (async)
    --------------------------------------------------------- */
    (async () => {
      try {
        const token = await createVerificationToken(userId, emailLC);
        await sendVerificationEmail(emailLC, token);
      } catch (_) {}
    })();

    /* ---------------------------------------------------------
       10) CREATE SESSION COOKIE
    --------------------------------------------------------- */
    try {
      const sid = await createSession({ userId, tenantId, companyId });

      const cookieName = process.env.SESSION_COOKIE_NAME || COOKIE_NAME;
      const isProd = process.env.NODE_ENV === "production";

      res.cookie(cookieName, sid, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        maxAge: SESSION_TTL_SECONDS * 1000,
        path: "/",
      });
    } catch (err) {
      console.error("session cookie error:", err);
    }

    /* ---------------------------------------------------------
       11) RETURN SUCCESS → redirect to onboarding
    --------------------------------------------------------- */
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

/* ---------------------------------------------------------
   RAW BODY PARSER (fallback)
--------------------------------------------------------- */
async function parseBody(req: Request) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

router.post("/", signupHandler);

export default router;
