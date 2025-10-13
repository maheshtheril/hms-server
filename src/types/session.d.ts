import "express-session";

declare module "express-session" {
  interface SessionData {
    user_id?: string;
    tenant_id?: string;
    roles?: string[];
  }
}
