// server/src/services/reorder.ts
import db from "../db";
import { forecastDemand } from "./forecast";

/**
 * Uses db.query(...) (node-postgres style) instead of pg-promise helpers.
 * Adjusts for db module that exposes { query, q, pool }.
 */

export async function getCurrentStock(productId: string): Promise<number> {
  const sql = `
    SELECT COALESCE(SUM(qty_on_hand), 0) AS qty
    FROM hms_product_batch
    WHERE product_id = $1
  `;
  const res = await db.query(sql, [productId]);
  const qty = res && res.rows && res.rows[0] ? Number(res.rows[0].qty || 0) : 0;
  return qty;
}

export async function getLeadTime(productId: string): Promise<number> {
  const sql = `
    SELECT AVG(lead_time_days) AS avg_lead
    FROM hms_product_supplier
    WHERE product_id = $1
  `;
  const res = await db.query(sql, [productId]);
  const avgLead =
    res && res.rows && res.rows[0] && res.rows[0].avg_lead != null
      ? Number(res.rows[0].avg_lead)
      : NaN;

  // fallback default lead time (days) when no supplier data
  return Number.isFinite(avgLead) ? Math.max(1, Math.round(avgLead)) : 3;
}

export async function reorderSuggestion(productId: string) {
  // forecastDemand returns { daily_forecast, monthly_forecast, history_days }
  const forecast = await forecastDemand(productId);
  const stock = await getCurrentStock(productId);
  const lead = await getLeadTime(productId);

  const daily = Math.max(0, Math.round(forecast.daily_forecast || 0));
  const safetyStock = Math.ceil(daily * 3); // 3-day buffer (opinionated)

  const requiredForLeadTime = daily * lead;

  const reorderPoint = Math.ceil(requiredForLeadTime + safetyStock);

  const reorderQty = Math.max(0, reorderPoint - stock);

  return {
    stock,
    daily_forecast: daily,
    lead_time: lead,
    safety_stock: safetyStock,
    reorder_point: reorderPoint,
    reorder_qty: reorderQty,
  };
}
