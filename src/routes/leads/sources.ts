// server/src/routes/leads/sources.ts
/**
 * Hardened lead sources routes.
 *
 * Improvements:
 * - router.param('id') validates :id as UUID early and returns 400 if invalid.
 * - Stores validated id in req.params._validatedId for handlers to use.
 * - Normalizes tenant_id with safeUUID everywhere and sends explicit null to SQL.
 * - Defensive middleware to normalize empty-string query params.
 * - Clearer error responses for POST/PUT for quicker debugging.
 * - Debug logging controlled by DEBUG constant.
 */

import { Router, Request, Response, NextFunction } from "express";
import db from "../../db";
import sessionLoader from "../../middleware/sessionLoader";

const router = Router();
const DEBUG = true;

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
    id: raw.id ?? raw.user_id ?? raw.userId,
    tenant_id: raw.tenant_id ?? raw.tenantId ?? raw.tenant ?? null,
    is_platform_admin: coerceBool(raw.is_platform_admin ?? raw.isPlatformAdmin ?? raw.platformAdmin),
    is_tenant_admin: coerceBool(raw.is_tenant_admin ?? raw.isTenantAdmin ?? raw.tenantAdmin),
    is_admin: coerceBool(raw.is_admin ?? raw.isAdmin),
    active_company_id: raw.active_company_id ?? raw.company_id ?? raw.companyId ?? null,
    ...raw,
  } as UserLike;
}

function getUser(req: Request): UserLike {
  const uFromUser = (req as any).user ?? null;
  const s = (req as any).session ?? null;

  if (uFromUser && typeof uFromUser === "object" && Object.keys(uFromUser).length > 0) {
    return normalizeUserShape(uFromUser);
  }

  if (s && typeof s === "object" && Object.keys(s).length > 0) {
    const normalized = {
      id: s.user_id ?? s.userId ?? s.id,
      tenant_id: s.tenant_id ?? s.tenantId ?? s.tenant ?? null,
      is_platform_admin: coerceBool(s.is_platform_admin ?? s.isPlatformAdmin ?? s.platformAdmin),
      is_tenant_admin: coerceBool(s.is_tenant_admin ?? s.isTenantAdmin ?? s.tenantAdmin),
      is_admin: coerceBool(s.is_admin ?? s.isAdmin),
      active_company_id: s.active_company_id ?? s.company_id ?? s.companyId ?? null,
      ...s,
    } as UserLike;
    return normalizeUserShape(normalized);
  }

  return {};
}

/** Return value if v looks like a UUID v4/v1 hex string, otherwise null */
function safeUUID(v: any): string | null {
  if (!v || typeof v !== "string") return null;
  const re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return re.test(v) ? v : null;
}

/**
 * router.param('id') - validate id early and keep validated copy
 */
router.param("id", (req: Request, res: Response, next: NextFunction, id: string) => {
  const v = safeUUID(id);
  if (!v) {
    if (DEBUG) {
      console.warn("[leads/sources] invalid id param (not UUID):", id, "originalUrl=", req.originalUrl);
    }
    return res.status(400).json({ error: "invalid_id", reason: "id_must_be_uuid" });
  }
  // store validated value on a non-conflicting key
  (req.params as any)._validatedId = v;
  next();
});

// defensive: normalize empty-string query values to undefined/null
router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.query) {
    Object.keys(req.query).forEach((k) => {
      const v = req.query[k];
      if (typeof v === "string" && v.trim() === "") {
        delete req.query[k];
      }
    });
  }
  if (DEBUG) {
    console.log("[LEADS/SOURCES] Incoming:", req.method, req.originalUrl, "params=", req.params);
  }
  next();
});

/**
 * GET /api/leads/sources?q=...
 */
router.get("/", sessionLoader.loadSessionOptional, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const qParam = String(req.query.q ?? "");
    const user = getUser(req);

    // ensure tenantId is only used when it's a valid UUID string
    const rawTenant = user?.tenant_id ?? null;
    const tenantId = safeUUID(rawTenant) ?? null;

    if (rawTenant && !tenantId) {
      // extra defensive log to help trace bad tenant values
      console.warn("[leads/sources] warning: user.tenant_id present but invalid UUID:", rawTenant);
    }

    if (DEBUG) {
      console.log("GET /api/leads/sources called by:", user?.id ?? "anon", { tenantId, q: qParam });
    }

    const sql = `
      SELECT id, tenant_id, key, name, config, created_at
      FROM public.lead_source
      WHERE (
          $1::text IS NULL
          OR tenant_id::text = $1
          OR tenant_id IS NULL
      )
      AND (name ILIKE $2 OR key ILIKE $2)
      ORDER BY name
      LIMIT 1000
    `;

    const { rows } = await db.query(sql, [tenantId, `%${qParam}%`]);
    return res.json({ data: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/leads/sources
 * permission: tenant admin or platform admin
 *
 * Accepts both { key, name } and { code, name } for backward compatibility.
 */
router.post("/", sessionLoader.requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;

    if (DEBUG) {
      console.log("POST /api/leads/sources called by:", user?.id ?? "anon", {
        isPlatformAdmin,
        isTenantAdmin,
        userTenant: user?.tenant_id,
        bodyPreview: {
          has_key: !!req.body?.key,
          has_code: !!req.body?.code,
          has_name: !!req.body?.name,
        },
      });
    }

    if (!isPlatformAdmin && !isTenantAdmin) {
      return res.status(403).json({ error: "forbidden", reason: "requires_admin" });
    }

    // Normalize key: accept 'key' or 'code', trim + uppercase
    const rawKey = (req.body?.key ?? req.body?.code ?? "")?.toString();
    const normalizedKey = rawKey?.trim() ? rawKey.trim().toUpperCase() : "";

    const name = (req.body?.name ?? "")?.toString().trim();
    const config = req.body?.config ?? {};

    let tenant_id: string | null = req.body?.tenant_id ?? user?.tenant_id ?? null;
    tenant_id = safeUUID(tenant_id) ?? null;

    if (isTenantAdmin && tenant_id && user?.tenant_id && tenant_id !== user.tenant_id) {
      return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    if (!normalizedKey || !name) {
      return res.status(400).json({
        error: "key_and_name_required",
        details: {
          provided: { key: !!req.body?.key, code: !!req.body?.code, name: !!req.body?.name },
          hint: "send JSON with { key: 'SOMEKEY', name: 'Human readable name' } or { code: 'SOMEKEY', name: '...' }",
        },
      });
    }

    const insert = `
      INSERT INTO public.lead_source (tenant_id, key, name, config, created_at)
      VALUES ($1,$2,$3,$4, now())
      RETURNING id, tenant_id, key, name, config, created_at
    `;

    try {
      const { rows } = await db.query(insert, [tenant_id ?? null, normalizedKey, name, config ?? {}]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ error: "duplicate_key_or_name" });
      // log error and return safe message
      console.error("[leads/sources] POST DB error:", e && (e.stack || e.message || e));
      return res.status(500).json({ error: "internal_server_error", message: "could_not_create_source" });
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/leads/sources/:id
 * Note: :id validated by router.param above; validated id available at req.params._validatedId
 */
router.get("/:id", sessionLoader.loadSessionOptional, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = (req.params as any)._validatedId ?? req.params.id;
    const { rows } = await db.query(
      "SELECT id, tenant_id, key, name, config, created_at FROM public.lead_source WHERE id = $1 LIMIT 1",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /api/leads/sources/:id
 */
router.put("/:id", sessionLoader.requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const callerId = user?.id ?? "anonymous";
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;
    const callerTenant = user?.tenant_id ?? null;

    if (DEBUG) {
      console.log("PUT /api/leads/sources/:id called by", callerId, { isPlatformAdmin, isTenantAdmin, callerTenant });
    }

    const id = (req.params as any)._validatedId ?? req.params.id;
    const existingRes = await db.query("SELECT id, tenant_id FROM public.lead_source WHERE id = $1 LIMIT 1", [id]);
    if (existingRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const existing = existingRes.rows[0];
    const sourceTenant = existing.tenant_id; // may be null (global)

    if (!isPlatformAdmin) {
      if (!isTenantAdmin) return res.status(403).json({ error: "forbidden" });
      if (!sourceTenant) return res.status(403).json({ error: "forbidden_global_resource" });
      if (callerTenant !== sourceTenant) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    // Normalize incoming key similarly to create
    const rawKey = (req.body?.key ?? req.body?.code ?? "")?.toString();
    const normalizedKey = rawKey?.trim() ? rawKey.trim().toUpperCase() : "";
    const name = (req.body?.name ?? "")?.toString().trim();
    const config = req.body?.config ?? {};

    if (!normalizedKey || !name) {
      return res.status(400).json({ error: "key_and_name_required" });
    }

    try {
      const { rows } = await db.query(
        `UPDATE public.lead_source
           SET key=$1, name=$2, config=$3, updated_at = now()
         WHERE id=$4
         RETURNING id, tenant_id, key, name, config, created_at`,
        [normalizedKey, name, config ?? {}, id]
      );

      if (rows.length === 0) return res.status(404).json({ error: "not_found" });
      return res.json({ data: rows[0] });
    } catch (e: any) {
      if (e?.code === "23505") return res.status(409).json({ error: "duplicate_key_or_name" });
      console.error("[leads/sources] PUT DB error:", e && (e.stack || e.message || e));
      return res.status(500).json({ error: "internal_server_error", message: "could_not_update_source" });
    }
  } catch (err: any) {
    return next(err);
  }
});

/**
 * DELETE /api/leads/sources/:id
 */
router.delete("/:id", sessionLoader.requireSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const callerId = user?.id ?? "anonymous";
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;
    const callerTenant = user?.tenant_id ?? null;

    if (DEBUG) {
      console.log("DELETE /api/leads/sources/:id called by", callerId, { isPlatformAdmin, isTenantAdmin, callerTenant });
    }

    const id = (req.params as any)._validatedId ?? req.params.id;
    const existingRes = await db.query("SELECT id, tenant_id FROM public.lead_source WHERE id = $1 LIMIT 1", [id]);
    if (existingRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const existing = existingRes.rows[0];
    const sourceTenant = existing.tenant_id;

    if (!isPlatformAdmin) {
      if (!isTenantAdmin) return res.status(403).json({ error: "forbidden" });
      if (!sourceTenant) return res.status(403).json({ error: "forbidden_global_resource" });
      if (callerTenant !== sourceTenant) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    await db.query("DELETE FROM public.lead_source WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
