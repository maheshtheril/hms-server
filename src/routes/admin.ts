// server/src/routes/admin.ts
import { Router } from "express";
import { q } from "../db";
import requireSession from "../middleware/requireSession";

const router = Router();

// All admin routes require a session
router.use(requireSession);

// ───────────────────────────────────────────────
// GET /api/admin/users  (TENANT-SCOPED)
// Query: page, pageSize, search, active, role, sort(name|email|status), dir(asc|desc)
// ───────────────────────────────────────────────
router.get("/users", async (req: any, res, next) => {
  try {
    const tenantId = String(req.session?.tenant_id || "").trim();
    if (!tenantId) return res.status(401).json({ error: "unauthenticated" });

    const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize ?? "20"), 10) || 20, 1), 100);
    const offset = (page - 1) * pageSize;

    const search = String(req.query.search ?? "").trim();
    const activeParam = String(req.query.active ?? "").trim().toLowerCase(); // "true" to filter only active
    const role = String(req.query.role ?? "").trim(); // "admin" | "tenant_admin" | "platform_admin" | ""
    const sort = String(req.query.sort ?? "name").toLowerCase(); // name | email | status
    const dir = String(req.query.dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    // Sort mapping → SQL expression
    let sortExpr = "LOWER(name)";
    if (sort === "email") sortExpr = "LOWER(email)";
    else if (sort === "status") sortExpr = "(CASE WHEN is_active THEN 1 ELSE 0 END)";

    // WHERE
    const params: any[] = [tenantId];
    const where: string[] = ["tenant_id = $1"];

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(`(email ILIKE $${params.length - 1} OR name ILIKE $${params.length})`);
    }
    if (activeParam === "true") {
      where.push(`is_active = TRUE`);
    }
    if (role) {
      // boolean flags on app_user (align with your schema)
      // role = admin|tenant_admin|platform_admin
      const col = role === "admin" ? "is_admin"
                 : role === "tenant_admin" ? "is_tenant_admin"
                 : role === "platform_admin" ? "is_platform_admin"
                 : "";
      if (col) where.push(`${col} = TRUE`);
    }

    // COUNT
    const { rows: crows } = await q(
      `SELECT COUNT(*)::int AS total
         FROM app_user
        WHERE ${where.join(" AND ")}`,
      params
    );
    const total = crows[0]?.total ?? 0;

    // PAGE
    params.push(pageSize, offset);
    const { rows: items } = await q(
      `SELECT
          id,
          email,
          name,
          is_active AS active,                    -- map to UI field
          COALESCE(is_admin,false)            AS is_admin,
          COALESCE(is_tenant_admin,false)     AS is_tenant_admin,
          COALESCE(is_platform_admin,false)   AS is_platform_admin,
          tenant_id,
          company_id,
          created_at
         FROM app_user
        WHERE ${where.join(" AND ")}
        ORDER BY ${sortExpr} ${dir}, created_at DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Shape expected by your UsersPage normalization
    res.json({ items, meta: { page, pageSize, total } });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────
router.get("/__health", (_req, res) => res.json({ ok: true, where: "admin router file" }));

export default router;
