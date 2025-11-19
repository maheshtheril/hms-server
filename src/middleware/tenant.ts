// server/src/middleware/tenant.ts
import { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string; // safe extension
    }
  }
}

/** Pure helper: Extract tenant id */
export function getTenantIdFromReq(req: Request): string | null {
  // prefer req.user.tenant_id (because your express.d.ts defines req.user)
  if (req.user?.tenant_id) return String(req.user.tenant_id);

  // fallback to session (your existing sessionLoader populates this)
  const anyReq = req as any;
  if (anyReq.session?.tenant_id) return String(anyReq.session.tenant_id);

  return null;
}

/** Middleware: requires tenant context */
export function requireTenant(req: Request, res: Response, next: NextFunction) {
  const tenantId = getTenantIdFromReq(req);
  if (!tenantId) {
    return res.status(403).json({
      error: "tenant_required",
      message: "Missing tenant context",
    });
  }

  req.tenantId = tenantId; // safe, non-conflicting
  next();
}
// src/middleware/tenant.ts
// --- your existing code above ---

// If you already have a function that performs tenant wrapping, export it as named:
export const withTenant = (handler: any) => {
  return async (req: any, res: any) => {
    // ensure tenant loaded into req.tenant (example)
    // if you already have logic, reuse it here
    try {
      // example: const tenant = await loadTenantFromReq(req);
      // req.tenant = tenant;
      return await handler(req, res);
    } catch (err) {
      // handle error or rethrow
      throw err;
    }
  };
};
