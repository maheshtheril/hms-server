// server/src/routes/api/auth/signup.ts
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../../../db";
import { createSession } from "../../../lib/session";
import { COOKIE_NAME, SESSION_TTL_SECONDS } from "../../../lib/session";
import { enqueueProvisionJob } from "../../../lib/provisioningQueue";
import rateLimitSignup from "../../../middleware/rateLimitSignup";
import domainTenantPolicy from "../../../lib/domainTenantPolicy";
import { createVerificationToken, sendVerificationEmail } from "../../../lib/emailVerification";

const router = Router();

console.info("[signup.ts] module loaded");

/* -------------------- PASSWORD POLICY -------------------- */
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

/* -------------------- TYPE GUARD -------------------- */
function isRateLimitFail(x: any): x is { ok: false; retryAfter: number } {
  return x && typeof x === "object" && x.ok === false && typeof x.retryAfter === "number";
}

/* -------------------- HELPERS -------------------- */
function slugifyBase(s: string) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function tryInsertTenantWithUniqueSlug(client: any, baseSlug: string, name: string) {
  // Try to insert tenant with slug, retry with suffixes on conflict
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i + 1}`;
    try {
      const t = await client.query(
        `INSERT INTO tenant (slug, name) VALUES ($1, $2) RETURNING id`,
        [candidate, name]
      );
      return { id: t.rows[0].id, slug: candidate };
    } catch (err: any) {
      // If unique violation on slug, continue; else rethrow
      if (err && err.code === "23505") {
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not create unique tenant slug after retries");
}

/* ============================================================
   SIGNUP HANDLER — hardened and ensures user_companies mapping
   ============================================================ */
export async function signupHandler(req: Request, res: Response) {
  console.info("[signup] invoked", {
    method: req.method,
    url: req.url,
    headers: { origin: req.headers.origin, host: req.headers.host, "content-type": req.headers["content-type"] },
  });

  let client: any | null = null;
  try {
    /* -------- 1. RATE LIMIT -------- */
    const rl = await rateLimitSignup(req);
    console.info("[signup] rateLimit result:", rl);
    if (isRateLimitFail(rl)) {
      return res.status(429).json({ error: "too_many_attempts", retryAfter: rl.retryAfter });
    }

    /* -------- 2. PARSE INPUT -------- */
    const { name, email, password, company, countryId, industry } =
      (req as any).body || (await parseBody(req));

    console.info("[signup] parsed body present?", !!(name || email || password || company || countryId));

    if (!name || !email || !password || !company || !countryId) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const emailLC = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(emailLC)) {
      return res.status(400).json({ error: "invalid_email" });
    }

    /* -------- 3. PASSWORD POLICY -------- */
    const pwErrors = checkPassword(password);
    if (pwErrors.length) {
      return res.status(400).json({ error: "weak_password", reasons: pwErrors });
    }

    /* -------- 4. DOMAIN TENANT RULE -------- */
    const dp = await domainTenantPolicy(emailLC).catch((e) => {
      console.error("[signup] domainTenantPolicy failed:", e);
      return null;
    });
    if (dp && !dp.ok) {
      return res.status(dp.status ?? 403).json({ error: dp.error });
    }

    /* -------- 5. DB CONNECTION -------- */
    client = await pool.connect();

    /* -------- 6. EMAIL EXISTS QUICK CHECK (best-effort) -------- */
    try {
      const existing = await client.query(
        `SELECT id FROM app_user WHERE LOWER(email)=LOWER($1) LIMIT 1`,
        [emailLC]
      );
      if (existing.rowCount > 0) {
        return res.status(409).json({ error: "email_exists" });
      }
    } catch (err) {
      console.error("email check failed:", err);
      return res.status(500).json({ error: "db_error" });
    }

    /* -------- 7. PASSWORD HASH -------- */
    const hash = await bcrypt.hash(password, 12);

    let tenantId: string;
    let companyId: string;
    let userId: string;

    /* -------- 8. TRANSACTION (tenant + company + user + mapping) -------- */
    try {
      await client.query("BEGIN");

      // TENANT — create slug with retries to avoid collisions
      const baseSlug = slugifyBase(company) || `org-${Math.random().toString(36).slice(2, 10)}`;
      let tenantIns;
      try {
        tenantIns = await tryInsertTenantWithUniqueSlug(client, baseSlug, company);
      } catch (err) {
        throw err;
      }
      tenantId = tenantIns.id;

      // COMPANY
      const c = await client.query(
        `INSERT INTO company (tenant_id, name, country_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, company, countryId]
      );
      companyId = c.rows[0].id;

      // INDUSTRY — safe update
      if (industry) {
        await client.query(`UPDATE company SET industry = $1 WHERE id = $2`, [industry, companyId]);
      }

      // USER — insert; handle possible duplicate email unique violation
      try {
        const u = await client.query(
          `INSERT INTO app_user
              (tenant_id, company_id, email, name, password, is_tenant_admin, is_active)
           VALUES ($1,$2,$3,$4,$5,true,true)
           RETURNING id`,
          [tenantId, companyId, emailLC, name, hash]
        );
        userId = u.rows[0].id;
      } catch (err: any) {
        if (err && err.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "email_exists" });
        }
        throw err;
      }

      // USER <-> COMPANY mapping: ensure it exists before commit so session routines find it
      // NOTE: user_companies uses composite PK (tenant_id, user_id, company_id) — no 'id' column
      await client.query(
        `INSERT INTO user_companies (tenant_id, user_id, company_id, is_default, created_at)
         VALUES ($1, $2, $3, true, now())
         ON CONFLICT (tenant_id, user_id, company_id) DO NOTHING`,
        [tenantId, userId, companyId]
      );

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      console.error("Signup TX error:", {
        message: err?.message,
        code: err?.code,
        detail: err?.detail,
        stack: err?.stack,
        constraint: err?.constraint,
      });

      return res.status(500).json({ error: "signup_failed" });
    }

    /* -------- 9. EMAIL VERIFICATION (best-effort async) -------- */
    (async () => {
      try {
        const token = await createVerificationToken(userId, emailLC);
        await sendVerificationEmail(emailLC, token);
      } catch (err) {
        console.error("verification_email_failed:", err);
      }
    })();

    /* -------- 10. PROVISIONING QUEUE (best-effort async) -------- */
    (async () => {
      try {
        await enqueueProvisionJob({
          tenantId,
          companyId,
          userId,
          countryId,
          industry: industry || null,
        });
      } catch (err) {
        console.error("enqueueProvisionJob failed:", err);
      }
    })();

    /* -------- 11. SESSION COOKIE (after commit) -------- */
    try {
      const sid = await createSession({ userId, tenantId, companyId });

      // Prefer Express helper so headers are handled correctly
      const cookieName = process.env.SESSION_COOKIE_NAME || COOKIE_NAME;
      const isProd = process.env.NODE_ENV === "production";

      // If this file is mounted as part of an Express app that has `res.cookie`, use it.
      // Using res.cookie avoids clobbering other Set-Cookie headers.
      res.cookie(cookieName, sid, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        path: "/",
        maxAge: SESSION_TTL_SECONDS * 1000,
        // domain: process.env.SESSION_COOKIE_DOMAIN || undefined
      });

      console.info("[signup] issued session", { sid, userId, tenantId, companyId });
    } catch (err) {
      console.error("session cookie error:", err);
      // don't fail signup — we still return success
    }

    /* -------- 12. SUCCESS -------- */
    return res.status(201).json({
      ok: true,
      tenantId,
      companyId,
      userId,
      requiresEmailVerification: true,
      provisioning: "queued",
    });
  } catch (err) {
    console.error("[signup] handler error:", err);
    return res.status(500).json({ error: "server_error" });
  } finally {
    if (client) {
      try {
        client.release();
      } catch (__) {}
    }
  }
}

/* ------------- RAW BODY PARSER ------------- */
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

// Attach to router and export default for easy mounting
router.post("/", signupHandler);

export default router;
