// types/session-override.d.ts
import "express-session";

/**
 * The canonical session payload for your SaaS ERP.
 */
interface AuthSessionPayload {
  sid?: string | null;
  user_id?: string | null;
  tenant_id?: string | null;
  company_id?: string | null;
  active_company_id?: string | null;
  is_admin?: boolean;
  is_tenant_admin?: boolean;
  is_platform_admin?: boolean;
  email?: string | null;
  name?: string | null;
  issued_at?: string | null;
  last_seen?: string | null;
}

/**
 * 1) Augment express-session SessionData
 */
declare module "express-session" {
  interface SessionData {
    authSession?: AuthSessionPayload;

    // your PG store flattens session keys (this is why TS errors happen)
    sid?: string;
    user_id?: string;
    tenant_id?: string;
    active_company_id?: string;
    company_id?: string;
  }
}

/**
 * 2) Augment Express.Request directly so req.authSession is always typed
 */
declare global {
  namespace Express {
    interface Request {
      authSession?: AuthSessionPayload;

      // force session to accept both augmented + store fields
      session?: import("express-session").Session &
        Partial<import("express-session").SessionData>;
    }
  }
}

export {};
