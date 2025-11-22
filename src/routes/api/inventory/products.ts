// server/src/routes/api/inventory/products.ts
import { pool } from "../../../db";
import { getSession } from "../../../lib/session";

export async function productsHandler(req, res) {
  try {
    const sid = req.cookies?.erp_session;
    const session = sid ? await getSession(sid) : null;
    if (!session || !session.company_id) return res.status(401).json({ error: "not_authenticated" });

    const companyId = session.company_id;

    if (req.method === "GET") {
      const { rows } = await pool.query(
        `SELECT id, sku, name, description, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, is_active
         FROM hms_product
         WHERE company_id = $1
         ORDER BY name LIMIT 500`,
        [companyId]
      );
      return res.json(rows);
    }

    if (req.method === "POST") {
      const { sku, name, description, is_stockable = true, is_service = false, uom = "each", valuation_method = "fifo", price = 0, currency = "USD", default_cost = 0 } = req.body || {};
      if (!name) return res.status(400).json({ error: "missing_name" });

      const { rows } = await pool.query(
        `INSERT INTO hms_product (id, tenant_id, company_id, sku, name, description, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, is_active, created_at, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, now(), $13)
         RETURNING *`,
        [session.tenant_id, companyId, sku || null, name, description || null, is_stockable, is_service, uom, valuation_method, price, currency, default_cost, session.user_id]
      );
      return res.status(201).json(rows[0]);
    }

    return res.status(405).json({ error: "method_not_allowed" });
  } catch (err) {
    console.error("[productsHandler] error", err);
    return res.status(500).json({ error: "server_error" });
  }
}
