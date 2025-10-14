import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { provisionTenantRBAC } from "../services/provisionTenant"; // ⬅️ stays

const router = Router();

/* ─────────────── Password policy section ─────────────── */
const PASSWORD_POLICY = {
  minLength: 12,
  maxLength: 128,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  banned: new Set([
    "abc123", "123456", "123456789", "password", "qwerty", "letmein", "admin", "welcome",
  ]),
  symbolRegex: /[^A-Za-z0-9]/,
};

function checkPassword(pw: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (typeof pw !== "string" || !pw.trim()) {
    reasons.push("Password is required.");
    return { ok: false, reasons };
  }
  if (pw.length < PASSWORD_POLICY.minLength) {
    reasons.push(`Minimum ${PASSWORD_POLICY.minLength} characters.`);
  }
  if (pw.length > PASSWORD_POLICY.maxLength) {
    reasons.push(`Maximum ${PASSWORD_POLICY.maxLength} characters.`);
  }
  if (PASSWORD_POLICY.banned.has(pw.toLowerCase())) {
    reasons.push("Too common / unsafe password.");
  }
  if (PASSWORD_POLICY.requireUpper && !/[A-Z]/.test(pw)) {
    reasons.push("Include at least one uppercase letter (A–Z).");
  }
  if (PASSWORD_POLICY.requireLower && !/[a-z]/.test(pw)) {
    reasons.push("Include at least one lowercase letter (a–z).");
  }
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw)) {
    reasons.push("Include at least one number (0–9).");
  }
  if (PASSWORD_POLICY.requireSymbol && !PASSWORD_POLICY.symbolRegex.test(pw)) {
    reasons.push("Include at least one symbol (e.g., !@#$%^&*).");
  }
  if (/(.)\1\1/.test(pw)) {
    reasons.push("Avoid 3 or more repeated characters in a row.");
  }
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwerty)/i.test(pw)) {
    reasons.push("Avoid simple sequences like '1234' or 'abcd'.");
  }
  return { ok: reasons.length === 0, reasons };
}

/* ─────────────── Utility helpers ─────────────── */
function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function listColumns(cx: any, table: string): Promise<Set<string>> {
  const r = await cx.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x: any) => String(x.column_name)));
}

function buildInsert(table: string, colsAvail: Set<string>, wanted: Record<string, any>) {
  const cols: string[] = [];
  const vals: any[] = [];
  const placeholders: string[] = [];
  let i = 1;
  for (const [col, value] of Object.entries(wanted)) {
    if (colsAvail.has(col)) {
      cols.push(col);
      vals.push(value);
      placeholders.push(`$${i++}`);
    }
  }
  if (cols.length === 0) throw new Error(`No matching columns to insert for table ${table}`);
  const text = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(
    ", "
  )}) RETURNING ${colsAvail.has("id") ? "id" : cols[0]}`;
  return { text, values: vals };
}

/* ─────────────── Main route ─────────────── */
router.post("/", async (req, res) => {
  const { org, name, email, password } = req.body || {};

  // Basic presence check
  if (
    typeof org !== "string" || !org.trim() ||
    typeof name !== "string" || !name.trim() ||
    typeof email !== "string" || !email.trim() ||
    typeof password !== "string" || !password.trim()
  ) {
    return res.status(400).json({ ok: false, error: "Missing or invalid fields" });
  }

  // ✅ Password strength validation
  const pwCheck = checkPassword(password);
  if (!pwCheck.ok) {
    return res.status(400).json({
      ok: false,
      error: "weak_password",
      reasons: pwCheck.reasons,
      requirements: {
        minLength: PASSWORD_POLICY.minLength,
        requireUpper: PASSWORD_POLICY.requireUpper,
        requireLower: PASSWORD_POLICY.requireLower,
        requireDigit: PASSWORD_POLICY.requireDigit,
        requireSymbol: PASSWORD_POLICY.requireSymbol,
      },
    });
  }

  const emailLc = email.trim().toLowerCase();
  const tenantId = randomUUID();
  const companyId = randomUUID();
  const userId = randomUUID();
  const now = new Date();
  const baseSlug = slugify(org) || `org-${tenantId.slice(0, 8)}`;

  const cx = await pool.connect();
  try {
    const tenantCols = await listColumns(cx, "tenant");
    const companyCols = await listColumns(cx, "company");
    const userCols = await listColumns(cx, "app_user");
    const mapCols = await listColumns(cx, "user_companies").catch(() => new Set<string>());

    // Schema sanity
    for (const [t, cols, reqs] of [
      ["tenant", tenantCols, ["id", "name"]],
      ["company", companyCols, ["id", "tenant_id", "name"]],
      ["app_user", userCols, ["id", "tenant_id", "name", "email"]],
    ] as const) {
      for (const c of reqs) {
        if (!cols.has(c)) {
          cx.release();
          return res.status(500).json({ ok: false, error: `Schema mismatch: ${t}.${c} missing` });
        }
      }
    }

    // Password field check + hash
    const hasPasswordHash = userCols.has("password_hash");
    const hasPassword = userCols.has("password");
    if (!hasPasswordHash && !hasPassword) {
      cx.release();
      return res.status(500).json({
        ok: false,
        error: "Schema mismatch: need app_user.password_hash or app_user.password",
      });
    }
    const passwordHash = await bcrypt.hash(password, 10);

    await cx.query("BEGIN");

    /* ─ Tenant ─ */
    const tenantWantedBase: Record<string, any> = {
      id: tenantId,
      name: org.trim(),
      is_active: true,
      created_at: now,
    };
    if (tenantCols.has("meta")) {
      tenantWantedBase["meta"] = {
        modules_enabled: ["crm", "hr", "accounts", "inventory", "projects", "reports"],
      };
    }

    if (tenantCols.has("slug")) {
      let slug = baseSlug;
      let success = false;
      for (let i = 0; i < 8 && !success; i++) {
        const tenantWanted = { ...tenantWantedBase, slug };
        const ins = buildInsert("tenant", tenantCols, tenantWanted);
        try {
          await cx.query(ins.text, ins.values);
          success = true;
        } catch (e: any) {
          if (e?.code === "23505") {
            slug = `${baseSlug}-${i + 2}`;
            continue;
          }
          throw e;
        }
      }
      if (!success) throw new Error("Could not create unique tenant slug after retries");
    } else {
      const ins = buildInsert("tenant", tenantCols, tenantWantedBase);
      await cx.query(ins.text, ins.values);
    }

    /* ─ Company ─ */
    const companyWanted: Record<string, any> = {
      id: companyId,
      tenant_id: tenantId,
      name: org.trim(),
      is_active: true,
      created_at: now,
    };
    const compIns = buildInsert("company", companyCols, companyWanted);
    await cx.query(compIns.text, compIns.values);

    /* ─ User ─ */
    const userWanted: Record<string, any> = {
      id: userId,
      tenant_id: tenantId,
      name: name.trim(),
      email: emailLc,
      is_owner: true,
      is_active: true,
      created_at: now,
    };
    if (userCols.has("is_admin")) userWanted["is_admin"] = true;
    if (userCols.has("is_tenant_admin")) userWanted["is_tenant_admin"] = true;
    if (hasPasswordHash) userWanted["password_hash"] = passwordHash;
    else userWanted["password"] = passwordHash;

    const userIns = buildInsert("app_user", userCols, userWanted);
    await cx.query(userIns.text, userIns.values);

    /* ─ User ↔ Company mapping ─ */
    if (mapCols.size > 0) {
      const mapWanted: Record<string, any> = {
        tenant_id: tenantId,
        company_id: companyId,
        user_id: userId,
        is_default: true,
        created_at: now,
      };
      const mapIns = buildInsert("user_companies", mapCols, mapWanted);
      try {
        await cx.query(mapIns.text, mapIns.values);
      } catch (e: any) {
        if (e?.code !== "23505") throw e;
      }
    }

    await cx.query("COMMIT");

    /* ─ RBAC provision ─ */
    try {
      await provisionTenantRBAC(pool, tenantId, userId);
    } catch (e) {
      console.error("[tenant-signup] RBAC provision error:", e);
    }

    cx.release();
    return res.status(201).json({ ok: true, tenantId, companyId, userId });
  } catch (err: any) {
    try {
      await cx.query("ROLLBACK");
    } catch {}
    cx.release();
    console.error("[tenant-signup] error:", err);
    if (process.env.NODE_ENV !== "production") {
      const payload: any = { ok: false, error: err?.message || "Signup failed" };
      if (err?.code) payload.code = err.code;
      if (err?.detail) payload.detail = err.detail;
      if (err?.table) payload.table = err.table;
      if (err?.column) payload.column = err.column;
      return res.status(500).json(payload);
    }
    return res.status(500).json({ ok: false, error: "Signup failed" });
  }
});

export default router;
