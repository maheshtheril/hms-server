import type { Request } from "express";

/**
 * Session row from DB
 */
export interface Session {
  sid: string;
  user_id: string;
  tenant_id?: string | null;
  company_id?: string | null;
  last_seen?: Date;
}

/**
 * Extend Express Request to carry session (populated by requireAuth).
 */
export interface AuthedRequest extends Request {
  session: Session;
}

/**
 * User row from app_user table (minimal shape).
 */
export interface AppUser {
  id: string;
  email: string;
  name?: string;
  is_admin?: boolean;
  tenant_id?: string | null;
  company_id?: string | null;
}
