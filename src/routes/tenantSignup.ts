// server/src/routes/tenantSignup.ts
import { Router } from "express";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { provisionTenantRBAC } from "../services/provisionTenant"; // ⬅️ stays

const router = Router();

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Return a set of column names for a table */
async function listColumns(table: string): Promise<Set<string>> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => String(x.column_name)));
}

/** Build an INSERT that only uses existing columns */
function buildInsert(
  table: string,
  colsAvail: Set<string>,
  wanted: Record<string, any>
) {
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
  if (cols.length === 0) {
    throw new Error(`No matching columns to insert for table ${table}`);
  }
  const text = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(
    ", "
  )}) RETURNING ${colsAvail.has("id") ? "id" : cols[0]}`;
  return { text, values: vals };
}

router.post("/", async (req, res) => {
  const { org, name, email, password } = req.body || {};
  if (
    typeof org !== "string" || !org.trim() ||
    typeof name !== "string" || !name.trim() ||
    typeof email !== "string" || !email.trim() ||
    typeof password !== "string" || !password.trim()
  ) {
    return res.status(400).json({ ok: false, error: "Missing or invalid fields" });
  }

  const emailLc = email.trim().toLowerCase();
  const tenantId = randomUUID();
  const companyId = randomUUID();
  const userId = randomUUID();
  const now = new Date();
  const baseSlug = slugify(org) || `org-${tenantId.slice(0, 8)}`;

  try {
    // Discover schema
    const tenantCols = await listColumns("tenant");
    const companyCols = await listColumns("company");
    const userCols = await listColumns("app_user");
    const mapCols = await listColumns("user_companies").catch(() => new Set<string>());

    // Required columns sanity
    for (const [t, cols, reqs] of [
      ["tenant", tenantCols, ["id", "name"]], // slug handled below if present & NOT NULL
      ["company", companyCols, ["id", "tenant_id", "name"]],
      ["app_user", userCols, ["id", "tenant_id", "name", "email"]],
    ] as const) {
      for (const c of reqs) {
        if (!cols.has(c)) {
          return res.status(500).json({ ok: false, error: `Schema mismatch: ${t}.${c} missing` });
        }
      }
    }

    // Determine password column
    const hasPasswordHash = userCols.has("password_hash");
    const hasPassword = userCols.has("password");
    const passwordHash = await bcrypt.hash(password, 10);
    if (!hasPasswordHash && !hasPassword) {
      return res.status(500).json({
        ok: false,
        error: "Schema mismatch: need app_user.password_hash or app_user.password",
      });
    }

    await pool.query("BEGIN");

    // 1) TENANT — include slug if present, and seed meta.modules_enabled if meta exists
    const tenantWantedBase: Record<string, any> = {
      id: tenantId,
      name: org.trim(),
      is_active: true,
      created_at: now,
    };

    // Prepare meta if column exists
    if (tenantCols.has("meta")) {
      tenantWantedBase["meta"] = {
        // You can trim this list if you want partial enablement by default
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
          await pool.query(ins.text, ins.values);
          success = true;
        } catch (e: any) {
          // 23505 = unique violation (likely slug unique)
          if (e?.code === "23505") {
            slug = `${baseSlug}-${(i + 2)}`; // try new slug
            continue;
          }
          throw e; // other errors bubble up
        }
      }
      if (!success) {
        throw new Error("Could not create unique tenant slug after retries");
      }
    } else {
      // No slug column in table → just insert without slug
      const tenantWanted = { ...tenantWantedBase };
      const ins = buildInsert("tenant", tenantCols, tenantWanted);
      await pool.query(ins.text, ins.values);
    }

    // 2) COMPANY (default)
    const companyWanted: Record<string, any> = {
      id: companyId,
      tenant_id: tenantId,
      name: org.trim(),
      is_active: true,
      created_at: now,
    };
    const compIns = buildInsert("company", companyCols, companyWanted);
    await pool.query(compIns.text, compIns.values);

    // 3) APP USER (owner, make admin if columns exist)
    const userWanted: Record<string, any> = {
      id: userId,
      tenant_id: tenantId,
      name: name.trim(),
      email: emailLc,
      is_owner: true,
      is_active: true,
      created_at: now,
    };

    // Grant admin flags for the first user when those columns exist
    if (userCols.has("is_admin")) userWanted["is_admin"] = true;
    if (userCols.has("is_tenant_admin")) userWanted["is_tenant_admin"] = true;

    if (hasPasswordHash) userWanted["password_hash"] = passwordHash;
    else userWanted["password"] = passwordHash;

    const userIns = buildInsert("app_user", userCols, userWanted);
    await pool.query(userIns.text, userIns.values);

    // 4) USER ↔ COMPANY mapping (optional)
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
        await pool.query(mapIns.text, mapIns.values);
      } catch (e: any) {
        if (e?.code !== "23505") throw e; // ignore unique violation if any
      }
    }

    await pool.query("COMMIT");

    // 5) RBAC provisioning (best-effort; won’t block signup)
    try {
      await provisionTenantRBAC(pool, tenantId, userId);
    } catch (e) {
      console.error("[tenant-signup] RBAC provision error:", e);
      // do not throw — signup already committed
    }

    return res.json({ ok: true, tenantId, companyId, userId });
  } catch (err: any) {
    try { await pool.query("ROLLBACK"); } catch {}
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
