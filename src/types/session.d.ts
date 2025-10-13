import "express-session";

declare module "express-session" {
  interface SessionData {
    user_id?: string;
    tenant_id?: string;
    role_codes?: string[];
    // add anything else you set on req.session
  }
}
