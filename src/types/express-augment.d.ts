import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    session?: {
      sid: string;
      user_id: string;
      tenant_id: string;
      active_company_id?: string | null;
      is_active?: boolean;
      is_admin?: boolean;
      is_tenant_admin?: boolean;
      is_platform_admin?: boolean;
      email?: string;
      name?: string;
    };
    company?: {
      active_company_id: string | null;
    };
  }
}
