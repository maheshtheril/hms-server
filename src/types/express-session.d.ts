// types/express-session.d.ts
import "express-session";
import type { PoolClient } from "pg";

declare module "express-session" {
  interface SessionData {
    /**
     * Optional app-level session payload stored inside express-session.
     * Use req.session.authSession to access.
     */
    authSession?: {
      sid?: string | null;
      user_id?: string | null;
      tenant_id?: string | null;
      company_id?: string | null;
      is_admin?: boolean;
      is_tenant_admin?: boolean;
      is_platform_admin?: boolean;
      email?: string | null;
      name?: string | null;
      issued_at?: string | null;
      last_seen?: string | null;
    };
  }
}

declare global {
  namespace Express {
    interface Request {
      /**
       * lightweight identity handy in controllers (not the same as session store)
       */
      user?: {
        id?: string;
        email?: string | null;
        name?: string | null;
        roles?: string[];
        permissions?: string[];
        is_admin?: boolean;
      };

      /**
       * Auth/session context attached by our middleware.
       * We avoid naming this `session` to prevent ts conflicts with express-session types.
       */
      authSession?: {
        sid?: string | null;
        user_id?: string | null;
        tenant_id?: string | null;
        company_id?: string | null;
        is_admin?: boolean;
        is_tenant_admin?: boolean;
        is_platform_admin?: boolean;
        email?: string | null;
        name?: string | null;
        issued_at?: string | null;
        last_seen?: string | null;
      };

      /**
       * optional per-request PG client if you use set_config('app.tenant_id', ...) approach
       */
      dbClient?: PoolClient;
    }
  }
}

export {};
