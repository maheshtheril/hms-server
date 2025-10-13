// src/types.ts
import type { Request } from "express";

/** Session row from DB (set by your auth middleware, NOT express-session) */
export interface AuthSession {
  sid: string;
  user_id: string;
  tenant_id?: string | null;
  company_id?: string | null;
  last_seen?: Date;
}

/** Express Request + your own session payload */
export type AuthedRequest = Request & {
  session: AuthSession;
};

/** User row from app_user table (minimal shape). */
export interface AppUser {
  id: string;
  email: string;
  name?: string;
  is_admin?: boolean;
  tenant_id?: string | null;
  company_id?: string | null;
}
