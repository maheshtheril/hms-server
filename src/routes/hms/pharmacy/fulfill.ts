// server/src/routes/hms/pharmacy/fulfill.ts
import express from "express";
import { pool } from "../../../db"; // adjust to your path
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

/**
 * POST /api/hms/pharmacy/billing/fulfill
 * Body:
 * {
 *   tenant_id, company_id, created_by, patient_id?, location_id,
 *   items: [{ product_id, batch_id?, quantity, unit_price, discount_amount, tax_rate, reservation_id? }, ...],
 *   payment: { amount, method, reference },
 * }
 * Header: Idempotency-Key (optional)
 */
router.post("/fulfill", async (req, res) => {
  const {
    tenant_id,
    company_id,
    created_by,
    patient_id = null,
    location_id,
    items,
    payment = null,
  } = req.body;

  const idempotencyKey = req.header("Idempotency-Key") || null;

  if (!tenant_id || !company_id || !created_by || !location_id) {
    return res.status(400).json({ error: "missing_required" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Validate and consume reservations (if present) — lock each reservation
    for (const it of items) {
      const qty = Number(it.quantity || 0);
      if (!qty || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid_item_quantity", item: it });
      }

      if (it.reservation_id) {
        // Lock reservation row for update
        const r = await client.query(
          `SELECT * FROM public.hms_stock_reservation WHERE id = $1 FOR UPDATE`,
          [it.reservation_id]
        );

        if (!r.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "reservation_not_found", reservation_id: it.reservation_id });
        }

        const resRow = r.rows[0];

        // Quick tenant/company/location sanity (optional but recommended)
        if (String(resRow.tenant_id) !== String(tenant_id) || String(resRow.company_id) !== String(company_id)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ error: "reservation_mismatch" });
        }

        // Ensure reservation is active — your schema may have status (if you applied earlier migration). If not, check expires_at
        // Here we treat rows without explicit status as active; adapt if you added a status column.
        // If you added status migration earlier, replace the check with resRow.status === 'active'
        // For safety handle expires_at as well
        const now = new Date();
        if (resRow.expires_at && new Date(resRow.expires_at) < now) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "reservation_expired", reservation_id: it.reservation_id });
        }

        const reservedQty = Number(resRow.qty || 0);
        if (reservedQty < qty) {
          // reserved less than requested -> conflict
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "insufficient_reserved_qty", reservation_id: it.reservation_id, reserved: reservedQty, requested: qty });
        }

        // Decrement reserved in hms_stock_levels for the product / batch / location
        // (batch_id may be null in stock_levels)
        const updateRes = await client.query(
          `UPDATE public.hms_stock_levels
           SET reserved = GREATEST(reserved - $1, 0), updated_at = now()
           WHERE tenant_id = $2 AND company_id = $3 AND product_id = $4 AND (batch_id IS NOT DISTINCT FROM $5) AND location_id = $6
           RETURNING reserved`,
          [qty, tenant_id, company_id, resRow.product_id, resRow.batch_id, resRow.location_id]
        );

        if (!updateRes.rows[0]) {
          // no stock_levels row found — this is a fatal inconsistency
          await client.query("ROLLBACK");
          return res.status(500).json({ error: "stock_levels_missing", product_id: resRow.product_id, batch_id: resRow.batch_id });
        }

        // Update reservation row: either mark consumed (if exact) or reduce qty
        if (reservedQty === qty) {
          // mark consumed (if you added a status column in migration; else delete or set consumed metadata)
          // If you applied the migration that added 'status' use it; otherwise set qty = 0 and leave
          // Try to update status if available
          try {
            await client.query(
              `UPDATE public.hms_stock_reservation SET qty = 0, expires_at = now(), updated_at = now() WHERE id = $1`,
              [it.reservation_id]
            );
          } catch (e) {
            // ignore failure updating extra columns; rollback below if it's critical
          }
        } else {
          // partial consume: reduce reservation qty
          const newQty = reservedQty - qty;
          await client.query(
            `UPDATE public.hms_stock_reservation SET qty = $1, updated_at = now() WHERE id = $2`,
            [newQty, it.reservation_id]
          );
        }
      }
    }

    // 2) Build arguments to call DB function pharmacy_fulfill_order
    // The DB function expects: (p_tenant_id uuid, p_company_id uuid, p_created_by uuid, p_patient_id uuid, p_encounter_id uuid, p_prescription_id uuid, p_location_id uuid, p_items jsonb, p_payment jsonb, p_idempotency_key text)
    // We'll pass nulls for optional encounter/prescription.
    const dbItems = items.map((it: any) => ({
      product_id: it.product_id,
      batch_id: it.batch_id || null,
      quantity: Number(it.quantity),
      unit_price: Number(it.unit_price || 0),
      discount_amount: Number(it.discount_amount || 0),
      tax_rate: Number(it.tax_rate || 0),
      reservation_id: it.reservation_id || null, // pass reservation ids so DB can log/use them if desired
    }));

    const funcRes = await client.query(
      `SELECT public.pharmacy_fulfill_order($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::jsonb,$9::jsonb,$10::text) as result`,
      [
        tenant_id,
        company_id,
        created_by,
        patient_id || null,
        null,
        null,
        location_id,
        JSON.stringify(dbItems),
        payment ? JSON.stringify(payment) : null,
        idempotencyKey,
      ]
    );

    const resultJson = funcRes.rows[0]?.result ?? null;

    // 3) Optionally mark reservations as 'consumed' explicitly if you added a status column
    // (We already adjusted qty/reserved above; if you added status, mark them consumed here for audit)
    // The above adjustments are sufficient; if you want status = 'consumed', do updates here.

    await client.query("COMMIT");
    return res.status(200).json(resultJson);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("pharmacy fulfill error", err);
    return res.status(500).json({ error: "fulfill_failed", message: String(err) });
  } finally {
    client.release();
  }
});

export default router;
