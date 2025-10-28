// server/src/types/express.d.ts
import "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      email?: string | null;
      name?: string | null;
      tenant_id?: string | null;
      company_id?: string | null;
      roles?: string[];
      permissions?: string[];
      is_admin?: boolean;
      is_tenant_admin?: boolean;
      is_platform_admin?: boolean;
    }

    interface Request {
      /**
       * Populated by your requireAuth middleware.
       * Optional because some endpoints might still be public.
       */
      user?: User;
    }
  }
}

export {};
