// routes/leads/sources.ts
import { Router, Request, Response, NextFunction } from "express";
import db from "../../db"; // adjust path to your DB client

const router = Router();

// Toggle verbose debug logs (set to `true` while debugging, `false` in prod)
const DEBUG = true;

/**
 * Helper: safe access for typed req.user (avoid TS noise if you don't have types)
 */
type UserLike = {
  id?: string;
  tenant_id?: string | null;
  is_platform_admin?: boolean;
  is_tenant_admin?: boolean;
  active_company_id?: string | null;
  [k: string]: any;
};

function getUser(req: Request): UserLike {
  // If your auth middleware attaches differently, adjust here.
  return (req as any).user ?? {};
}

/**
 * GET /api/leads/sources?q=...
 * List sources. Tenant-scoped: platform admins can see global + tenant; tenant users see tenant + global.
 */
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q ?? "");
    const user = getUser(req);
    const tenantId = user?.tenant_id ?? null;

    if (DEBUG) {
      console.log("GET /api/leads/sources called by:", user?.id ?? "anon", { tenantId, q });
    }

    const sql = `
      SELECT id, tenant_id, key, name, config, created_at
      FROM public.lead_source
      WHERE ($1::uuid IS NULL OR tenant_id = $1 OR tenant_id IS NULL)
        AND (name ILIKE $2 OR key ILIKE $2)
      ORDER BY name
      LIMIT 1000
    `;

    const { rows } = await db.query(sql, [tenantId, `%${q}%`]);
    return res.json({ data: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/leads/sources
 * Body: { key, name, config, tenant_id? }
 *
 * Permission model:
 * - platform admins can create global (tenant_id = NULL) or tenant-scoped sources
 * - tenant admins can only create sources for their own tenant
 */
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;

    if (DEBUG) {
      console.log("POST /api/leads/sources called by:", user?.id ?? "anon", {
        isPlatformAdmin,
        isTenantAdmin,
        userTenant: user?.tenant_id,
        bodyPreview: { key: req.body?.key, name: req.body?.name },
      });
    }

    if (!isPlatformAdmin && !isTenantAdmin) {
      return res.status(403).json({ error: "forbidden", reason: "requires_admin" });
    }

    const { key, name, config } = req.body ?? {};
    let tenant_id: string | null = req.body?.tenant_id ?? user?.tenant_id ?? null;

    // Tenant admins cannot create for other tenants (safety)
    if (isTenantAdmin && tenant_id && user?.tenant_id && tenant_id !== user.tenant_id) {
      return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    if (!key || !name) {
      return res.status(400).json({ error: "key_and_name_required" });
    }

    const insert = `
      INSERT INTO public.lead_source (tenant_id, key, name, config, created_at)
      VALUES ($1,$2,$3,$4, now())
      RETURNING id, tenant_id, key, name, config, created_at
    `;

    try {
      const { rows } = await db.query(insert, [tenant_id ?? null, key, name, config ?? {}]);
      return res.status(201).json({ data: rows[0] });
    } catch (e: any) {
      // Unique violation (adjust code if your DB client differs)
      if (e?.code === "23505") {
        return res.status(409).json({ error: "duplicate_key_or_name" });
      }
      throw e;
    }
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/leads/sources/:id
 */
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id;
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
 * body: { key, name, config }
 *
 * Permission model:
 * - platform admins can update any source
 * - tenant admins can update sources that belong to their tenant only (and cannot update global sources)
 */
router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const callerId = user?.id ?? "anonymous";
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;
    const callerTenant = user?.tenant_id ?? null;

    if (DEBUG) {
      console.log("PUT /api/leads/sources/:id called by", callerId, { isPlatformAdmin, isTenantAdmin, callerTenant });
    }

    const id = req.params.id;
    const existingRes = await db.query("SELECT id, tenant_id FROM public.lead_source WHERE id = $1 LIMIT 1", [id]);
    if (existingRes.rows.length === 0) return res.status(404).json({ error: "not_found" });

    const existing = existingRes.rows[0];
    const sourceTenant = existing.tenant_id; // may be null (global)

    // Authorization
    if (!isPlatformAdmin) {
      if (!isTenantAdmin) return res.status(403).json({ error: "forbidden" });
      if (!sourceTenant) return res.status(403).json({ error: "forbidden_global_resource" });
      if (callerTenant !== sourceTenant) return res.status(403).json({ error: "forbidden_tenant_mismatch" });
    }

    const { key, name, config } = req.body ?? {};
    const { rows } = await db.query(
      `UPDATE public.lead_source
         SET key=$1, name=$2, config=$3, updated_at = now()
       WHERE id=$4
       RETURNING id, tenant_id, key, name, config, created_at`,
      [key, name, config ?? {}, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    return res.json({ data: rows[0] });
  } catch (err: any) {
    if (err?.code === "23505") return res.status(409).json({ error: "duplicate_key_or_name" });
    return next(err);
  }
});

/**
 * DELETE /api/leads/sources/:id
 *
 * Permission model:
 * - platform admins can delete any source
 * - tenant admins can delete sources that belong to their tenant only (not global)
 */
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = getUser(req);
    const callerId = user?.id ?? "anonymous";
    const isPlatformAdmin = !!user?.is_platform_admin;
    const isTenantAdmin = !!user?.is_tenant_admin;
    const callerTenant = user?.tenant_id ?? null;

    if (DEBUG) {
      console.log("DELETE /api/leads/sources/:id called by", callerId, { isPlatformAdmin, isTenantAdmin, callerTenant });
    }

    const id = req.params.id;
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
