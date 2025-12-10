// server/src/services/forecast.ts
import db from "../db";

/**
 * Uses db.query(sql, params) (node-postgres style) instead of pg-promise helpers.
 * Adjust if your db module exposes a different method (e.g. db.q).
 */

type ConsumptionRow = {
  date: string;
  qty: string | number;
};

export async function getConsumption(productId: string): Promise<ConsumptionRow[]> {
  const sql = `
    SELECT 
      DATE(created_at) AS date,
      SUM(-qty_change) AS qty
    FROM hms_product_stock_ledger
    WHERE product_id = $1
      AND movement_type = 'sale'
      AND qty_change < 0
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `;

  const res = await db.query(sql, [productId]);
  // res.rows should be an array of { date, qty }
  return (res && res.rows) ? (res.rows as ConsumptionRow[]) : [];
}

function exponentialSmoothing(history: number[], alpha = 0.4) {
  if (!history || history.length === 0) return 0;

  let forecast = history[0];

  for (let i = 1; i < history.length; i++) {
    forecast = alpha * history[i] + (1 - alpha) * forecast;
  }
  return forecast;
}

export async function forecastDemand(productId: string) {
  const rows = await getConsumption(productId);
  const values = rows.map((r) => Number(r.qty || 0)).filter((v) => !Number.isNaN(v));

  const dailyForecastRaw = exponentialSmoothing(values);
  const dailyForecast = Math.max(0, Math.round(dailyForecastRaw));
  const next30 = Math.round(dailyForecast * 30);

  return {
    daily_forecast: dailyForecast,
    monthly_forecast: next30,
    history_days: values.length,
  };
}
