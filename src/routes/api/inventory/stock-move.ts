// server/src/routes/api/inventory/stock-move.ts
import { pool } from "../../../db";
import { getSession } from "../../../lib/session";

export async function stockMoveHandler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

    const sid = req.cookies?.erp_session;
    const session = sid ? await getSession(sid) : null;
    if (!session || !session.company_id) return res.status(401).json({ error: "not_authenticated" });

    const { productId, fromLocationId, toLocationId, qty, uom='each', cost = 0, reference='', source='manual' } = req.body || {};
    if (!productId || !toLocationId || typeof qty !== 'number') return res.status(400).json({ error: "missing_fields" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1) insert stock_move record (audit)
      const moveRes = await client.query(
        `INSERT INTO hms_stock_move (id, tenant_id, company_id, product_id, location_from, location_to, lot_id, qty, uom, move_type, source, source_reference, cost, created_by, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, $6, $7, 'internal', $8, $9, $10, $11, now())
         RETURNING id`,
        [session.tenant_id, session.company_id, productId, fromLocationId || null, toLocationId, qty, uom, source, reference, cost, session.user_id]
      );
      const moveId = moveRes.rows[0].id;

      // 2) ledger: decrement fromLocation (if present)
      if (fromLocationId) {
        await client.query(
          `INSERT INTO hms_stock_ledger (id, tenant_id, company_id, product_id, related_type, related_id, movement_type, qty, uom, unit_cost, total_cost, from_location_id, to_location_id, batch_id, lot_number, reference, created_at, metadata)
           VALUES (gen_random_uuid(), $1, $2, $3, 'stock_move', $4, 'out', -$5, $6, $7, -($7 * $5), $8, $9, NULL, NULL, $10, now(), '{}')`,
          [session.tenant_id, session.company_id, productId, moveId, qty, uom, cost, fromLocationId, toLocationId, reference]
        );

        // update hms_stock_levels: subtract reserved/quantity safely (upsert style)
        await client.query(
          `UPDATE hms_stock_levels
           SET quantity = GREATEST(quantity - $1, 0), updated_at = now()
           WHERE company_id = $2 AND product_id = $3 AND location_id = $4`,
          [qty, session.company_id, productId, fromLocationId]
        );
      }

      // 3) ledger: increment toLocation
      await client.query(
        `INSERT INTO hms_stock_ledger (id, tenant_id, company_id, product_id, related_type, related_id, movement_type, qty, uom, unit_cost, total_cost, from_location_id, to_location_id, batch_id, lot_number, reference, created_at, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, 'stock_move', $4, 'in', $5, $6, $7, ($7 * $5), $8, $9, NULL, NULL, $10, now(), '{}')`,
      [session.tenant_id, session.company_id, productId, moveId, qty, uom, cost, fromLocationId || null, toLocationId, reference]);

      // upsert stock_levels for toLocation
      await client.query(
        `INSERT INTO hms_stock_levels (id, tenant_id, company_id, product_id, batch_id, location_id, quantity, reserved, updated_at, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3, NULL, $4, $5, 0, now(), '{}')
         ON CONFLICT (company_id, product_id, location_id) DO UPDATE
         SET quantity = hms_stock_levels.quantity + EXCLUDED.quantity, updated_at = now()`,
        [session.tenant_id, session.company_id, productId, toLocationId, qty]
      );

      await client.query("COMMIT");
      return res.status(201).json({ ok: true, moveId });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[stockMoveHandler] txn failed", err);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[stockMoveHandler] error", err);
    return res.status(500).json({ error: "server_error" });
  }
}
