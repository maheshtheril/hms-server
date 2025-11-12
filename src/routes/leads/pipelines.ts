// server/src/routes/leads/pipelines.ts
/**
 * Production-ready pipelines router with soft-delete & restore
 */

import { Router, Request } from "express";
import db from "../../db";
import sessionLoader from "../../middleware/sessionLoader";

const router = Router();
const DEBUG = true;

/* Helpers (normalize shapes + uuid) */
type UserLike = { id?: string; tenant_id?: string | null; is_platform_admin?: boolean; is_tenant_admin?: boolean; is_admin?: boolean; [k: string]: any };

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
    ...raw,
  };
}
function getUser(req: Request): UserLike {
  const u = (req as any).user;
  const s = (req as any).session;
  if (u && typeof u === "object" && Object.keys(u).length) return normalizeUserShape(u);
  if (s && typeof s === "object" && Object.keys(s).length) return normalizeUserShape(s);
  return {};
}
function safeUUID(v: any): string | null {
  if (!v || typeof v !== "string") return null;
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return re.test(v) ? v : null;
}

/* param validation */
router.param("id", (req, res, next, id) => {
  const valid = safeUUID(id);
  if (!valid) {
    if (DEBUG) console.warn("[lead_pipeline] invalid id:", id);
    return res.status(400).json({ error: "invalid_id", reason: "id_must_be_uuid" });
  }
  (req.params as any)._validatedId = valid;
  next();
});

/* GET list (excludes deleted by default) */
router.get("/", sessionLoader.loadSessionOptional, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "");
    const withDeleted = String(req.query.with_deleted ?? "0") === "1";
    const user = getUser(req);
    const tenantId = safeUUID(user?.tenant_id) ?? null;

    const sql = `
      SELECT id, tenant_id, name, description, is_active, created_by, created_at,
             COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
      FROM public.lead_pipeline
      WHERE ($1::uuid IS NULL OR tenant_id = $1 OR tenant_id IS NULL)
        AND (name ILIKE $2)
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

/* POST create (admin required) */
router.post("/", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    if (!user?.is_platform_admin && !user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });

    const name = (req.body?.name ?? "").toString().trim();
    const description = req.body?.description ?? null;
    const is_active = coerceBool(req.body?.is_active ?? true);
    const tenant_id = safeUUID(req.body?.tenant_id ?? user?.tenant_id) ?? null;
    const created_by = safeUUID(user?.id) ?? null;

    if (!name) return res.status(400).json({ error: "name_required" });

    const insert = `
      INSERT INTO public.lead_pipeline
        (tenant_id, name, description, is_active, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,now(),now())
      RETURNING id, tenant_id, name, description, is_active, created_by, created_at, updated_at
    `;
    try {
      const { rows } = await db.query(insert, [tenant_id, name, description ?? null, is_active, created_by]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ error: "duplicate_name" });
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

/* GET one */
router.get("/:id", sessionLoader.loadSessionOptional, async (req, res, next) => {
  try {
    const id = (req.params as any)._validatedId;
    const { rows } = await db.query(
      `SELECT id, tenant_id, name, description, is_active, created_by, created_at,
              COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
       FROM public.lead_pipeline WHERE id=$1 LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

/* PUT update */
router.put("/:id", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    const id = (req.params as any)._validatedId;

    const existing = await db.query("SELECT id, tenant_id FROM public.lead_pipeline WHERE id=$1 LIMIT 1", [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    const name = (req.body?.name ?? "").toString().trim();
    const description = req.body?.description ?? null;
    const is_active = typeof req.body?.is_active === "boolean" ? coerceBool(req.body.is_active) : null;
    if (!name) return res.status(400).json({ error: "name_required" });

    const { rows } = await db.query(
      `UPDATE public.lead_pipeline
         SET name=$1, description=$2, is_active = COALESCE($3, is_active), updated_at = now()
       WHERE id=$4
       RETURNING id, tenant_id, name, description, is_active, created_by, created_at, updated_at, deleted_at, deleted_by`,
      [name, description ?? null, is_active, id]
    );
    if (!rows.length) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (e: any) {
    if (e?.code === "23505") return res.status(409).json({ error: "duplicate_name" });
    DEBUG && console.error("[lead_pipeline] PUT error:", e);
    next(e);
  }
});

/* DELETE -> soft-delete */
router.delete("/:id", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    const id = (req.params as any)._validatedId;

    const existing = await db.query("SELECT id, tenant_id FROM public.lead_pipeline WHERE id=$1 LIMIT 1", [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    const deletedBy = safeUUID(user?.id) ?? null;
    await db.query(
      `UPDATE public.lead_pipeline
         SET deleted_at = now(), deleted_by = $1, is_active = false, updated_at = now()
       WHERE id = $2`,
      [deletedBy, id]
    );
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* POST restore */
router.post("/:id/restore", sessionLoader.requireSession, async (req, res, next) => {
  try {
    const user = getUser(req);
    const id = (req.params as any)._validatedId;

    const existing = await db.query("SELECT id, tenant_id FROM public.lead_pipeline WHERE id=$1 LIMIT 1", [id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not_found" });
    const srcTenant = existing.rows[0].tenant_id;

    if (!user?.is_platform_admin) {
      if (!user?.is_tenant_admin && !user?.is_admin) return res.status(403).json({ error: "forbidden" });
      if (srcTenant && srcTenant !== user?.tenant_id) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    await db.query(
      `UPDATE public.lead_pipeline
         SET deleted_at = NULL, deleted_by = NULL, is_active = true, updated_at = now()
       WHERE id = $1`,
      [id]
    );

    const { rows } = await db.query(
      `SELECT id, tenant_id, name, description, is_active, created_by, created_at,
              COALESCE(updated_at, created_at) as updated_at, deleted_at, deleted_by
       FROM public.lead_pipeline WHERE id=$1 LIMIT 1`,
      [id]
    );
    return res.json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
