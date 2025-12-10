// server/src/services/classifier.ts
import db from "../db";

type ABCRow = {
  id: string;
  name: string;
  value: number | string;
};

type FSNRow = {
  id: string;
  name: string;
  movements: number | string;
};

/**
 * ABC classification (value-based)
 * A = top 70% of value, B = next 20%, C = last 10%
 */
export async function classifyABC() {
  const sql = `
    SELECT p.id, p.name, COALESCE(SUM(-l.qty_change * COALESCE(p.price,0)),0) AS value
    FROM hms_product p
    JOIN hms_product_stock_ledger l ON l.product_id = p.id
    WHERE l.movement_type = 'sale'
    GROUP BY p.id, p.name
    ORDER BY value DESC
  `;

  const res = await db.query(sql);
  const items: ABCRow[] = (res && res.rows) ? (res.rows as ABCRow[]) : [];

  // convert values to numbers and compute total
  const itemsWithNum = items.map((it) => ({ ...it, value: Number(it.value || 0) }));
  const total = itemsWithNum.reduce((sum, i) => sum + (Number(i.value) || 0), 0);

  let cumulative = 0;
  return itemsWithNum.map((i) => {
    cumulative += Number(i.value || 0);
    const percentile = total > 0 ? cumulative / total : 0;
    let classType = "C";
    if (percentile <= 0.7) classType = "A";
    else if (percentile <= 0.9) classType = "B";
    return {
      id: i.id,
      name: i.name,
      value: Number(i.value || 0),
      abc: classType,
    };
  });
}

/**
 * FSN classification (movement-frequency based)
 * F = Fast (movements > 30)
 * S = Slow (movements > 5)
 * N = Non-moving (<= 5)
 */
export async function classifyFSN() {
  const sql = `
    SELECT p.id, p.name, COUNT(*) AS movements
    FROM hms_product p
    JOIN hms_product_stock_ledger l ON l.product_id = p.id
    WHERE l.movement_type = 'sale'
    GROUP BY p.id, p.name
    ORDER BY movements DESC
  `;

  const res = await db.query(sql);
  const rows: FSNRow[] = (res && res.rows) ? (res.rows as FSNRow[]) : [];

  return rows.map((r) => {
    const movements = Number(r.movements || 0);
    const fsn = movements > 30 ? "F" : movements > 5 ? "S" : "N";
    return {
      id: r.id,
      name: r.name,
      movements,
      fsn,
    };
  });
}
