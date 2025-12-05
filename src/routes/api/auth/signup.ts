// server/src/routes/api/auth/signup.ts
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../../../db";
import {
  issueSession,
  // keep other exports if you need them elsewhere in this file
  buildClearSessionCookie,
  SESSION_TTL_SECONDS,
} from "../../../lib/session";
import rateLimitSignup from "../../../middleware/rateLimitSignup";
import domainTenantPolicy from "../../../lib/domainTenantPolicy";
import { createVerificationToken, sendVerificationEmail } from "../../../lib/emailVerification";

const router = Router();

console.info("[signup.ts] module loaded");

/* ------------------------------- DEBUG query wrapper ------------------------------- */
async function q(client: any, text: string, params: any[] = []) {
  try {
    return await client.query(text, params);
  } catch (err: any) {
    try {
      console.error(
        "[pg][query_error]",
        text,
        params,
        JSON.stringify(err, Object.getOwnPropertyNames(err))
      );
    } catch (e) {
      console.error("[pg][query_error] fallback", text, params, err);
    }
    throw err;
  }
}

/* ------------------------------- PASSWORD POLICY ------------------------------- */
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

/* ------------------------------- SLUGIFY ------------------------------- */
function slugifyBase(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/* ------------------ Tenant slug helper ------------------ */
async function tryInsertTenantWithUniqueSlug(client: any, baseSlug: string, name: string) {
  for (let i = 0; i < 7; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    try {
      const r = await q(
        client,
        `INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id`,
        [candidate, name]
      );
      return { id: r.rows[0].id, slug: candidate };
    } catch (err: any) {
      if (err && err.code === "23505") continue;
      throw err;
    }
  }
  throw new Error("Unable to create unique tenant slug");
}

/* ------------------ Country + Currency helpers ------------------ */
const isUuid = (s: any) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function resolveCountryUUID(client: any, countryId: string): Promise<string> {
  if (!countryId) throw new Error("empty_countryId");

  if (isUuid(countryId)) {
    const r = await q(client, `SELECT id FROM countries WHERE id = $1 LIMIT 1`, [countryId]);
    if (r.rowCount > 0) return countryId;
    throw new Error(`invalid_country_uuid:${countryId}`);
  }

  const qVal = String(countryId).trim().toUpperCase();
  const r = await q(
    client,
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

async function resolveCurrencyForCountry(client: any, countryId: string): Promise<string | null> {
  try {
    const mapped = await q(
      client,
      `SELECT cur.id, cur.code
       FROM country_default_currency cdc
       JOIN currencies cur ON cur.id = cdc.currency_id
       WHERE cdc.country_id = $1 AND cdc.is_active = true AND cur.is_active = true
       ORDER BY cdc.created_at DESC
       LIMIT 1`,
      [countryId]
    );
    if (mapped.rowCount > 0) {
      console.debug("[signup] resolved currency from country_default_currency:", mapped.rows[0].code);
      return mapped.rows[0].id;
    }
  } catch (err) {
    console.error("[signup] error while checking country_default_currency:", err);
  }

  try {
    const prefer = await q(
      client,
      `SELECT id, code FROM currencies WHERE is_active = true AND code IN ('USD','EUR')
       ORDER BY CASE WHEN code='USD' THEN 0 WHEN code='EUR' THEN 1 ELSE 2 END LIMIT 1`
    );
    if (prefer.rowCount > 0) {
      console.debug("[signup] falling back to preferred currency:", prefer.rows[0].code);
      return prefer.rows[0].id;
    }
  } catch (err) {
    console.error("[signup] error while checking preferred currencies:", err);
  }

  try {
    const anyCur = await q(client, `SELECT id, code FROM currencies WHERE is_active = true LIMIT 1`);
    if (anyCur.rowCount > 0) {
      console.debug("[signup] falling back to any active currency:", anyCur.rows[0].code);
      return anyCur.rows[0].id;
    }
  } catch (err) {
    console.error("[signup] error while fetching any active currency:", err);
  }

  return null;
}

/* ------------------ Cookie helpers (express res.cookie) ------------------ */
// Keep name consistent with other auth routes
const COOKIE_NAME =
  (process.env.SESSION_COOKIE_NAME ||
    process.env.COOKIE_NAME_SID ||
    process.env.COOKIE_NAME ||
    "sid").toString();
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_DOMAIN = (process.env.SESSION_COOKIE_DOMAIN || process.env.COOKIE_DOMAIN || "").toString().trim() || undefined;

function cookieOptions() {
  return {
    httpOnly: true,
    secure: IS_PROD, // must be true (HTTPS) for SameSite=None to be accepted in browsers
    sameSite: IS_PROD ? ("none" as const) : ("lax" as const),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_SECONDS * 1000), // milliseconds for res.cookie
    ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
  } as const;
}

/* ============================================================
   SIGNUP HANDLER
============================================================ */
export async function signupHandler(req: Request, res: Response) {
  console.info("[signup] invoked");

  try {
    console.debug("[signup] headers:", {
      "content-type": (req.headers["content-type"] || "").toString(),
      "x-forwarded-for": req.headers["x-forwarded-for"] || null,
      host: req.headers.host || null,
    });
    console.debug("[signup] req.body (raw):", JSON.stringify((req as any).body || null));
  } catch (_) {}

  let client: any | null = null;

  try {
    /* 1) rate limit */
    const rl = await rateLimitSignup(req);
    if (rl && (rl as any).ok === false) {
      return res
        .status(429)
        .json({ error: "too_many_attempts", retryAfter: (rl as any).retryAfter ?? 60 });
    }

    /* 2) parse input */
    const { name, email, password, company, countryId, industry } = (req as any).body || {};
    if (!name || !email || !password || !company || !countryId) {
      const missing: string[] = [];
      if (!name) missing.push("name");
      if (!email) missing.push("email");
      if (!password) missing.push("password");
      if (!company) missing.push("company");
      if (!countryId) missing.push("countryId");
      return res.status(400).json({ error: "missing_fields", missing });
    }

    const emailLC = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(emailLC)) {
      return res.status(400).json({ error: "invalid_email" });
    }

    /* 3) password check */
    const pwErrors = checkPassword(password);
    if (pwErrors.length) {
      return res.status(400).json({ error: "weak_password", reasons: pwErrors });
    }

    /* 4) domain policy */
    const dPolicy = await domainTenantPolicy(emailLC).catch(() => null);
    if (dPolicy && !dPolicy.ok) {
      return res.status(dPolicy.status ?? 403).json({ error: dPolicy.error });
    }

    /* 5) db */
    client = await pool.connect();

    /* 6) email exists? */
    const existing = await q(
      client,
      `SELECT id FROM app_user WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [emailLC]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: "email_exists" });
    }

    /* 7) hash */
    const hash = await bcrypt.hash(password, 12);

    /* 8) TX */
    let tenantId: string;
    let companyId: string;
    let userId: string;

    try {
      await q(client, "BEGIN");

      const baseSlug = slugifyBase(company) || `org-${Math.random().toString(36).slice(2)}`;
      const tenantRow = await tryInsertTenantWithUniqueSlug(client, baseSlug, company);
      tenantId = tenantRow.id;

      console.debug("[signup] resolveCountryUUID input countryId:", countryId);
      let resolvedCountryId: string;
      try {
        resolvedCountryId = await resolveCountryUUID(client, countryId);
      } catch (err: any) {
        console.error("[signup] country resolution failed:", err?.message || err);
        await q(client, "ROLLBACK").catch(() => {});
        return res
          .status(400)
          .json({ error: "invalid_country", message: String(err?.message || err) });
      }

      const c = await q(
        client,
        `
        INSERT INTO company (tenant_id, name, country_id)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
        [tenantId, company, resolvedCountryId]
      );
      companyId = c.rows[0].id;

      if (industry) {
        await q(client, `UPDATE company SET industry = $1 WHERE id = $2`, [industry, companyId]);
      }

      let currencyId: string | null = null;
      try {
        currencyId = await resolveCurrencyForCountry(client, resolvedCountryId);
      } catch (err) {
        console.error("[signup] currency resolution error:", err);
      }

      if (!currencyId) {
        await q(client, "ROLLBACK").catch(() => {});
        return res.status(500).json({
          error: "no_currency_available",
          message: "No active currencies found. Seed the currencies and country_default_currency tables.",
        });
      }

      await q(
        client,
        `
        INSERT INTO company_settings (
          id, tenant_id, company_id,
          currency_id,
          default_tax_type_id,
          default_tax_rate_id,
          rounding_precision,
          numbering_prefix,
          numbering_next,
          address_country_id,
          auto_load_taxes_from_country,
          created_at, updated_at,
          hms_sub_industry,
          hms_departments,
          hms_billing_mode
        )
        VALUES (
          gen_random_uuid(),
          $1, $2,
          $3,
          NULL,
          NULL,
          2,
          'INV',
          1,
          $4,
          true,
          now(), now(),
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT (company_id) DO NOTHING
        `,
        [tenantId, companyId, currencyId, resolvedCountryId]
      );

      try {
        const u = await q(
          client,
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
        if (err && err.code === "23505") {
          await q(client, "ROLLBACK").catch(() => {});
          return res.status(409).json({ error: "email_exists" });
        }
        throw err;
      }

      await q(
        client,
        `
        INSERT INTO user_companies (tenant_id, user_id, company_id, is_default, created_at)
        VALUES ($1, $2, $3, true, now())
        ON CONFLICT (tenant_id, user_id, company_id) DO NOTHING
      `,
        [tenantId, userId, companyId]
      );

      await q(client, "COMMIT");
    } catch (err) {
      await q(client, "ROLLBACK").catch(() => {});
      try {
        console.error("Signup TX error (full):", JSON.stringify(err, Object.getOwnPropertyNames(err)));
      } catch (e) {
        console.error("Signup TX error (fallback):", err);
      }
      return res.status(500).json({ error: "signup_failed" });
    }

    /* 9) async verification email */
    (async () => {
      try {
        const token = await createVerificationToken(userId, emailLC);
        await sendVerificationEmail(emailLC, token);
      } catch (_) {}
    })();

    /* 10) SESSION COOKIE — CREATE SESSION (match login behavior: issueSession + res.cookie) */
    try {
      // create SID via canonical DB helper (issueSession keeps logic centralized)
      const sid = await issueSession(userId, tenantId ?? null, companyId ?? null);

      // set cookie via express helper (matches your /login path)
      try {
        res.cookie(COOKIE_NAME, sid, cookieOptions());

        // helpful debug header in non-prod so you can see cookie details in the response headers
        if (process.env.NODE_ENV !== "production") {
          res.setHeader("X-Debug-Set-Cookie", `${COOKIE_NAME}=${sid}; domain=${COOKIE_DOMAIN || "host-only"}; samesite=${IS_PROD ? "None" : "Lax"}`);
        }
      } catch (cErr) {
        console.error("[signup] failed to set cookie via res.cookie:", cErr);
        return res.status(500).json({ error: "session_cookie_failed", detail: String(cErr?.message || cErr) });
      }

      // sanity readback for debug (log, but don't fail the request if this readback fails)
      try {
        const sBack = await pool.query("SELECT sid, tenant_id, company_id, user_id, created_at FROM sessions WHERE sid = $1", [sid]);
        console.info("[signup] session readback after insert:", sBack.rows[0]);
      } catch (rbErr) {
        console.error("[signup] session readback failed after insert (non-fatal):", rbErr);
      }

      // return sid in JSON as a fallback for clients that can't accept cookies
      return res.status(201).json({
        ok: true,
        tenantId,
        companyId,
        userId,
        sid,
        redirect: "/tenant/onboarding/hms",
      });
    } catch (err) {
      console.error("session cookie error (unexpected):", err);
      return res.status(500).json({ error: "session_error", detail: String(err?.message || err) });
    }
  } catch (err) {
    console.error("[signup] handler error:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    if (client) client.release();
  }
}

router.post("/", signupHandler);
export default router;
