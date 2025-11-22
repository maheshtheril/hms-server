// server/src/lib/inventory.ts
import { pool } from "../db";

export async function getDefaultLocationForCompany(companyId: string) {
  const { rows } = await pool.query(`SELECT id, name FROM hms_stock_locations WHERE company_id=$1 AND is_default = true LIMIT 1`, [companyId]);
  return rows[0] ?? null;
}

export async function getProduct(productId: string, companyId: string) {
  const { rows } = await pool.query(`SELECT * FROM hms_product WHERE id=$1 AND company_id=$2 LIMIT 1`, [productId, companyId]);
  return rows[0] ?? null;
}
