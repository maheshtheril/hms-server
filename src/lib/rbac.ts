// server/src/lib/rbac.ts
export function ensurePlatform(user: any): boolean {
  if (!user) return false;
  // trust your session payload: is_platform_admin or a platform role in user.roles
  return !!(user.is_platform_admin ||
            (Array.isArray(user.roles) &&
             user.roles.some((r: string) =>
               ['platform_owner','platform_admin','global_super_admin'].includes(String(r).toLowerCase())
             )));
}
