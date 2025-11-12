/**
 * server/src/routes/leads/sources.ts
 *
 * Lead Sources Routes — production ready with soft-delete & restore
 * - full CRUD (key, name, description, is_active, config)
 * - router.param('id') validates UUID early.
 * - Safe tenant checks for multi-tenant mode.
 * - Soft-delete (deleted_at, deleted_by) and restore endpoint.
 * - List excludes deleted rows by default; supports ?with_deleted=1
 */

import { Router, Request, Response, NextFunction } from "express";
import db from "../../db";
import sessionLoader from "../../middleware/sessionLoader";

const router = Router();
const DEBUG = true;

/* ---------------------- helpers ---------------------- */
type UserLike = {
  id?: string;
  tenant_id?: string | null;
  is_platform_admin?: boolean;
  is_tenant_admin?: boolean;
  is_admin?: boolean;
  active_company_id?: string | null;
  [k: string]: any;
};

function coerceBool(v: any): boolean {
  return v === true || v === "true" || v === 1 || v === "1" || v === "t" || v === "T";
}

function normalizeUserShape(raw: any): UserLike {
  return {
    id: raw?.id ?? raw?.user_id ?? raw?.userId,
    tenant_id: raw?.tenant_id ?? raw?.tenantId ?? raw?.tenant ?? null,
    is_platform_admin: coerceBool(raw?.is_platform_admin ?? raw?.isPlatformAdmin ?? raw?.platformAdmin),
    is_tenant_admin: coerceBool(raw?.is_tenant_admin ?? raw?.isTenantAdmin ?? raw?.tenantAdmin),
    is_admin: coerceBool(raw?.is_admin ?? raw?.isAdmin),
    active_company_id: raw?.active_company_id ?? raw?.company_id ?? raw?.companyId ?? null,
    ...raw,
  } as UserLike;
}

function getUser(req: Request): UserLike {
  const u = (req as any).user;
  const s = (req as any).session;
  if (u && typeof u === "object" && Object.keys(u).length) return normalizeUserShape(u);
  if (s && typeof s === "object" && Object.keys(s).length) return normalizeUserShape(s);
  return {};
}

/** validate UUID strings */
function safeUUID(v: any): string | null {
  if (!v || typeof v !== "string") return null;
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return re.test(v) ? v : null;
}

/* ---------------------- param validation ---------------------- */
router.param("id", (req, res, next, id) => {
  const valid = safeUUID(id);
  if (!valid) {
    if (DEBUG) console.warn("[lead_source] invalid id param:", id);
    return res.status(400).json({ error: "invalid_id", reason: "id_must_be_uuid" });
  }
  (req.params as any)._validatedId = valid;
  next();
});

/* ---------------------- GET list ---------------------- */
/**
 * GET /api/leads/sources?q=...&with_deleted=1
 * - tenant-scoped: returns tenant-specific + global (tenant_id IS NULL).
 * - excludes soft-deleted rows by default.
 */
router.get("/", sessionLoader.loadSessionOptional, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    const withDeleted = String(req.query.with_deleted ?? "0") === "1";
    const user = getUser(req);
    const tenantId = safeUUID(user?.tenant_id) ?? null;

    const sql = `
      SELECT id, tenant_id, key, name, description, is_active, config, created_at, COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
      FROM public.lead_source
      WHERE (
        $1::text IS NULL OR tenant_id::text = $1 OR tenant_id IS NULL
      )
      AND (name ILIKE $2 OR key ILIKE $2)
      AND ($3::int = 1 OR deleted_at IS NULL)
      ORDER BY name
      LIMIT 1000
    `;

    const { rows } = await db.query(sql, [tenantId, `%${q}%`, withDeleted ? 1 : 0]);
    return res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- POST create ---------------------- */
router.post("/", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    if (!user?.is_platform_admin && !user?.is_tenant_admin && !user?.is_admin)
      return res.status(403).json({ error: "forbidden", reason: "requires_admin" });

    const key = (req.body?.key ?? req.body?.code ?? "").toString().trim().toUpperCase();
    const name = (req.body?.name ?? "").toString().trim();
    const description = req.body?.description ?? null;
    const is_active = coerceBool(req.body?.is_active ?? true);
    const config = req.body?.config ?? {};
    const tenant_id = safeUUID(req.body?.tenant_id ?? user?.tenant_id) ?? null;
    const created_by = safeUUID(user?.id) ?? null;

    if (!key || !name) return res.status(400).json({ error: "key_and_name_required" });

    const insert = `
      INSERT INTO public.lead_source
        (tenant_id, key, name, description, is_active, config, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
      RETURNING id, tenant_id, key, name, description, is_active, config, created_by, created_at, updated_at
    `;

    try {
      const { rows } = await db.query(insert, [tenant_id, key, name, description, is_active, config, created_by]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505")
        return res.status(409).json({ error: "duplicate_key_or_name" });
      throw e;
    }
  } catch (e: any) {
    console.error("[lead_source] POST error:", e);
    res.status(500).json({ error: "internal_error", message: e.message });
  }
});

/* ---------------------- GET one ---------------------- */
router.get("/:id", sessionLoader.loadSessionOptional, async (req, res, next) => {
  try {
    const id = (req.params as any)._validatedId;
    const { rows } = await db.query(
      `SELECT id, tenant_id, key, name, description, is_active, config, created_by, created_at, COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
       FROM public.lead_source WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- PUT update ---------------------- */
router.put("/:id", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    const id = (req.params as any)._validatedId;

    const existing = await db.query(
      "SELECT id, tenant_id FROM public.lead_source WHERE id=$1 LIMIT 1",
      [id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id)
        return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    const key = (req.body?.key ?? req.body?.code ?? "").toString().trim().toUpperCase();
    const name = (req.body?.name ?? "").toString().trim();
    const description = req.body?.description ?? null;
    const is_active = coerceBool(req.body?.is_active ?? true);
    const config = req.body?.config ?? {};

    if (!key || !name) return res.status(400).json({ error: "key_and_name_required" });

    try {
      const { rows } = await db.query(
        `UPDATE public.lead_source
           SET key=$1, name=$2, description=$3, is_active=$4, config=$5, updated_at = now()
         WHERE id=$6
         RETURNING id, tenant_id, key, name, description, is_active, config, created_by, created_at, updated_at, deleted_at, deleted_by`,
        [key, name, description, is_active, config, id]
      );

      if (!rows.length) return res.status(404).json({ error: "not_found" });
      return res.json({ data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505")
        return res.status(409).json({ error: "duplicate_key_or_name" });
      throw e;
    }
  } catch (e: any) {
    console.error("[lead_source] PUT error:", e);
    res.status(500).json({ error: "internal_error", message: e.message });
  }
});

/* ---------------------- Soft DELETE ---------------------- */
/**
 * DELETE /api/leads/sources/:id
 * Soft-deletes record (deleted_at, deleted_by), sets is_active=false
 */
router.delete("/:id", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    const id = (req.params as any)._validatedId;

    const existing = await db.query(
      "SELECT id, tenant_id FROM public.lead_source WHERE id=$1 LIMIT 1",
      [id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id)
        return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    const deletedBy = safeUUID(user?.id) ?? null;
    await db.query(
      `UPDATE public.lead_source
         SET deleted_at = now(), deleted_by = $1, is_active = false, updated_at = now()
       WHERE id = $2`,
      [deletedBy, id]
    );

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- Restore ---------------------- */
/**
 * POST /api/leads/sources/:id/restore
 * Clears deleted_at/deleted_by and re-activates the row
 */
/* POST /:id/restore — improved logging & error responses */
router.post("/:id/restore", sessionLoader.requireSession, async (req, res, next) => {
  const id = (req.params as any)._validatedId;
  const user = getUser(req);

  try {
    // fetch existing row for tenant checks
    const existing = await db.query("SELECT id, tenant_id FROM public.lead_source WHERE id=$1 LIMIT 1", [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    // permission checks
    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    // attempt restore
    await db.query(
      `UPDATE public.lead_source
         SET deleted_at = NULL, deleted_by = NULL, is_active = true, updated_at = now()
       WHERE id = $1`,
      [id]
    );

    // return the row (fresh)
    const { rows } = await db.query(
      `SELECT id, tenant_id, key, name, description, is_active, config, created_by, created_at,
              COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
       FROM public.lead_source WHERE id=$1 LIMIT 1`,
      [id]
    );
    return res.json({ data: rows[0] });
  } catch (err: any) {
    // explicit logging — will appear in your service logs
    console.error("[lead_source] restore error:", {
      message: err?.message,
      stack: err?.stack,
      code: err?.code,
      detail: err?.detail,
      hint: err?.hint,
    });

    // friendly JSON to client with PG-specific details if present
    const payload: any = { error: "restore_failed", message: err?.message ?? "unknown_error" };
    if (err?.code) payload.pg_code = err.code;
    if (err?.detail) payload.pg_detail = err.detail;
    if (err?.hint) payload.pg_hint = err.hint;
    return res.status(500).json(payload);
  }
});


export default router;
