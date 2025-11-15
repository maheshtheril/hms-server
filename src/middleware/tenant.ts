// server/src/middleware/tenant.ts
import { RequestHandler } from "express";

export const withTenant: RequestHandler = (req, _res, next) => {
  try {
    let tenant = (req.headers["x-tenant-id"] as string) || null;
    if (!tenant && req.cookies) {
      tenant = String(req.cookies.tenant_id || req.cookies.tenantId || "") || null;
    }
    // attach tenant (string or null)
    (req as any).tenant = tenant ?? null;
  } catch (e) {
    (req as any).tenant = null;
  }
  return next();
};
