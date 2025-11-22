// types/express-session.d.ts
import "express-session";
import type { PoolClient } from "pg";

declare module "express-session" {
  interface SessionData {
    // session-level payload persisted in the session store (e.g. pg sessions table)
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
      // lightweight identity attached by middleware
      user?: {
        id?: string;
        email?: string | null;
        name?: string | null;
        roles?: string[];
        permissions?: string[];
        is_admin?: boolean;
      };

      // canonical auth/session context for this app
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

      // optional per-request pg client
      dbClient?: PoolClient;
    }
  }
}

// ensure this file is treated as a module
export {};
