// server/src/routes/hms/reserve.ts
import express from "express";
import { pool } from "../../db"; // your existing pg pool
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

// Helpers
async function getStockLevelForProductBatch(client: any, tenant_id: string, company_id: string, product_id: string, batch_id: string | null, location_id: string) {
  // Prefer per-batch info when batch_id provided, else fall back to stock_levels
  if (batch_id) {
    // materialized view or hms_stock_levels by batch
    const q = `
      SELECT qty::numeric AS qty
      FROM public.hms_product_batch_stock_mv mv
      WHERE mv.batch_id = $1
      LIMIT 1
    `;
    const r = await client.query(q, [batch_id]);
    if (r.rows[0]) return Number(r.rows[0].qty);
    // fallback to stock_levels
  }

  const q2 = `
    SELECT quantity::numeric AS quantity, reserved::numeric AS reserved
    FROM public.hms_stock_levels
    WHERE product_id = $1 AND location_id = $2
    LIMIT 1
  `;
  const r2 = await client.query(q2, [product_id, location_id]);
  if (!r2.rows[0]) return null;
  const qAvail = Number(r2.rows[0].quantity) - Number(r2.rows[0].reserved || 0);
  return qAvail;
}

/**
 * POST /api/hms/reserve
 * body: { tenant_id, company_id, product_id, batch_id?, quantity, location_id, reserved_for?, idempotency_key? }
 * returns { data: { reservation_id, expires_at } }
 */
router.post("/", async (req, res) => {
  const { tenant_id, company_id, product_id, batch_id = null, quantity, location_id, reserved_for = null, idempotency_key = null, created_by = null } = req.body;
  if (!tenant_id || !company_id || !product_id || !quantity || !location_id) {
    return res.status(400).json({ error: "missing_required" });
  }
  const qty = Number(quantity);
  if (qty <= 0) return res.status(400).json({ error: "invalid_quantity" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // idempotency: return existing reservation if idempotency_key matches
    if (idempotency_key) {
      const existing = await client.query(
        `SELECT id, qty, expires_at, status FROM public.hms_stock_reservation WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency_key]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return res.status(200).json({ data: { reservation_id: existing.rows[0].id, expires_at: existing.rows[0].expires_at, status: existing.rows[0].status } });
      }
    }

    // Check availability
    const available = await getStockLevelForProductBatch(client, tenant_id, company_id, product_id, batch_id, location_id);
    if (available === null) {
      // cannot determine availability -> fail safe (you may allow reservation if policy)
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "no_stock_data" });
    }
    if (qty > Number(available)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "insufficient_stock", available });
    }

    // Insert reservation
    const reservationId = uuidv4();
    // set short expiry (e.g., 10 minutes) — let frontend refresh as needed
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await client.query(
      `INSERT INTO public.hms_stock_reservation (id, tenant_id, company_id, product_id, location_id, qty, reserved_for, expires_at, created_by, idempotency_key, created_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), 'active')`,
      [reservationId, tenant_id, company_id, product_id, location_id, qty, reserved_for, expiresAt, created_by, idempotency_key]
    );

    // Increase reserved counter in hms_stock_levels (atomic)
    await client.query(
      `UPDATE public.hms_stock_levels
       SET reserved = reserved + $1, updated_at = now()
       WHERE product_id = $2 AND location_id = $3`,
      [qty, product_id, location_id]
    );

    await client.query("COMMIT");
    return res.status(201).json({ data: { reservation_id: reservationId, expires_at: expiresAt } });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("reserve error", err);
    return res.status(500).json({ error: "reserve_failed", message: String(err) });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/hms/reserve/:id
 * body: { quantity }
 * updates reservation qty (increase or decrease) — adjusts hms_stock_levels.reserved accordingly
 */
router.patch("/:id", async (req, res) => {
  const reservationId = req.params.id;
  const { quantity } = req.body;
  if (!quantity) return res.status(400).json({ error: "missing_quantity" });
  const qty = Number(quantity);
  if (qty <= 0) return res.status(400).json({ error: "invalid_quantity" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT * FROM public.hms_stock_reservation WHERE id = $1 FOR UPDATE`, [reservationId]);
    if (!r.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const row = r.rows[0];
    if (row.status !== "active") { await client.query("ROLLBACK"); return res.status(400).json({ error: "reservation_not_active" }); }

    // compute delta
    const oldQty = Number(row.qty);
    const delta = qty - oldQty;

    if (delta > 0) {
      // need to ensure availability
      // check hms_stock_levels
      const qAvail = await client.query(`SELECT quantity::numeric AS quantity, reserved::numeric AS reserved FROM public.hms_stock_levels WHERE product_id = $1 AND location_id = $2 FOR UPDATE`, [row.product_id, row.location_id]);
      if (!qAvail.rows[0]) { await client.query("ROLLBACK"); return res.status(400).json({ error: "no_stock_data" }); }
      const available = Number(qAvail.rows[0].quantity) - Number(qAvail.rows[0].reserved || 0);
      if (delta > available) { await client.query("ROLLBACK"); return res.status(409).json({ error: "insufficient_stock", available }); }
    }

    // update reservation
    await client.query(`UPDATE public.hms_stock_reservation SET qty = $1, updated_at = now() WHERE id = $2`, [qty, reservationId]);

    // update reserved counter
    await client.query(`UPDATE public.hms_stock_levels SET reserved = reserved + $1, updated_at = now() WHERE product_id = $2 AND location_id = $3`, [delta, row.product_id, row.location_id]);

    await client.query("COMMIT");
    return res.status(200).json({ data: { reservation_id: reservationId, qty } });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("update reservation error", err);
    return res.status(500).json({ error: "update_failed" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/hms/reserve/:id/release
 * releases a reservation (decrement reserved counter and mark reservation 'released')
 */
router.post("/:id/release", async (req, res) => {
  const reservationId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT * FROM public.hms_stock_reservation WHERE id = $1 FOR UPDATE`, [reservationId]);
    if (!r.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    const row = r.rows[0];
    if (row.status !== "active") { await client.query("COMMIT"); return res.status(200).json({ data: { released: true } }); }

    const qty = Number(row.qty);

    await client.query(`UPDATE public.hms_stock_reservation SET status = 'released', updated_at = now() WHERE id = $1`, [reservationId]);

    await client.query(`UPDATE public.hms_stock_levels SET reserved = GREATEST(reserved - $1, 0), updated_at = now() WHERE product_id = $2 AND location_id = $3`, [qty, row.product_id, row.location_id]);

    await client.query("COMMIT");
    return res.status(200).json({ data: { released: true } });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("release reservation error", err);
    return res.status(500).json({ error: "release_failed" });
  } finally {
    client.release();
  }
});

export default router;
