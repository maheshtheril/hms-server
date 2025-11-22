// server/src/routes/api/auth/signup.ts
import bcrypt from "bcryptjs";
import { pool } from "../../../db";
import { createSession, buildSessionCookie } from "../../../lib/session";
import { enqueueProvisionJob } from "../../../lib/provisioningQueue";
import rateLimitSignup from "../../../middleware/rateLimitSignup";
import domainTenantPolicy from "../../../lib/domainTenantPolicy";
import { createVerificationToken, sendVerificationEmail } from "../../../lib/emailVerification";

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
        // continue to next candidate
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not create unique tenant slug after retries");
}

/* ============================================================
   SIGNUP HANDLER — FIXED / HARDENED
   ============================================================ */
export async function signupHandler(req, res) {
  let client: any | null = null;
  try {
    /* -------- 1. RATE LIMIT -------- */
    const rl = await rateLimitSignup(req);
    if (isRateLimitFail(rl)) {
      return res.status(429).json({ error: "too_many_attempts", retryAfter: rl.retryAfter });
    }

    /* -------- 2. PARSE INPUT -------- */
    const { name, email, password, company, countryId, industry } =
      req.body || (await parseBody(req));

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
    const dp = await domainTenantPolicy(emailLC).catch(() => null);
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

    /* -------- 8. TRANSACTION (tenant + company + user) -------- */
    try {
      await client.query("BEGIN");

      // TENANT — create slug with retries to avoid collisions
      const baseSlug = slugifyBase(company) || `org-${Math.random().toString(36).slice(2, 10)}`;
      let tenantIns;
      try {
        tenantIns = await tryInsertTenantWithUniqueSlug(client, baseSlug, company);
      } catch (err) {
        // If slug insertion fails due to unexpected reason, rethrow to rollback
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
        // If someone else created the same email in race window, return 409
        if (err && err.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "email_exists" });
        }
        throw err;
      }

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      console.error("Signup TX error:", err);
      // return 500 for unknown errors
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

    /* -------- 11. SESSION COOKIE -------- */
    try {
      const sid = await createSession({ userId, tenantId, companyId });
      const cookieHeader = buildSessionCookie(sid);
      res.setHeader("Set-Cookie", cookieHeader);
    } catch (err) {
      console.error("session cookie error:", err);
      // don't fail signup
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
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
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
