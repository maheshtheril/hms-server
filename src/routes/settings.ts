// server/src/routes/settings.ts
import { Router, Request, Response } from "express";
import { PoolClient } from "pg";
import db from "../db"; // expects db.pool to be a pg.Pool

const router = Router();

/*
|-----------------------------------------------------------------------
| Helper: Send errors cleanly
|-----------------------------------------------------------------------
*/
function fail(res: Response, err: any) {
  console.error("[settings error]", err);
  return res.status(500).json({ error: err?.message || "internal_error" });
}

/*
|-----------------------------------------------------------------------
| Helper: Run a DB query WITH tenant context
|-----------------------------------------------------------------------
|
| Use `set_config` instead of `SET LOCAL ... = $1` so the tenant value
| can be passed as a parameter safely.
*/
async function withTenant<T>(tenantId: string | null, fn: (client: PoolClient) => Promise<T>) {
  const client = await db.pool.connect();
  try {
    // Parameter-safe way to set a session-local config value
    await client.query("SELECT set_config('app.tenant', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    client.release();
  }
}

/*
|-----------------------------------------------------------------------
| GET /api/settings
| List all visible settings (global + tenant)
|-----------------------------------------------------------------------
*/
router.get("/", async (req: Request, res: Response) => {
  try {
    const tenantId =
      (req.headers["x-tenant-id"] && String(req.headers["x-tenant-id"])) || null;

    const rows = await withTenant(tenantId, async (client) => {
      const out = await client.query(
        `SELECT id, tenant_id, company_id, key, value, scope, version, created_at, updated_at
         FROM global_settings
         WHERE tenant_id IS NULL OR tenant_id = $1
         ORDER BY key`,
        [tenantId]
      );
      return out.rows;
    });

    return res.json(rows);
  } catch (err) {
    return fail(res, err);
  }
});

/*
|-----------------------------------------------------------------------
| GET /api/settings/effective?key=...&companyId=...
|-----------------------------------------------------------------------
*/
router.get("/effective", async (req: Request, res: Response) => {
  try {
    const key = req.query.key ? String(req.query.key) : null;
    if (!key) return res.status(400).json({ error: "key is required" });

    const tenantId =
      (req.headers["x-tenant-id"] && String(req.headers["x-tenant-id"])) || null;

    const companyId = req.query.companyId ? String(req.query.companyId) : null;

    const value = await withTenant(tenantId, async (client) => {
      const out = await client.query(
        `SELECT get_setting($1, $2, $3) AS v`,
        [key, tenantId, companyId]
      );
      return out.rows[0]?.v ?? null;
    });

    return res.json({ key, value });
  } catch (err) {
    return fail(res, err);
  }
});

/*
|-----------------------------------------------------------------------
| POST /api/settings
| Body: { key, value, tenant_id?, company_id? }
|-----------------------------------------------------------------------
*/
router.post("/", async (req: Request, res: Response) => {
  try {
    const body = req.body || {};

    if (!body.key) return res.status(400).json({ error: "key required" });
    if (body.value === undefined)
      return res.status(400).json({ error: "value required" });

    const headerTenant =
      (req.headers["x-tenant-id"] && String(req.headers["x-tenant-id"])) || null;

    const actor =
      (req.headers["x-user-id"] && String(req.headers["x-user-id"])) || null;

    const payload = {
      key: String(body.key),
      value: body.value,
      tenant_id: body.tenant_id ?? headerTenant,
      company_id: body.company_id ?? null,
      actor,
    };

    await withTenant(payload.tenant_id, async (client) => {
      await client.query(
        `SELECT set_setting($1::text, $2::jsonb, $3::uuid, $4::uuid, $5::uuid)`,
        [
          payload.key,
          JSON.stringify(payload.value),
          payload.tenant_id,
          payload.company_id,
          payload.actor,
        ]
      );
    });

    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
