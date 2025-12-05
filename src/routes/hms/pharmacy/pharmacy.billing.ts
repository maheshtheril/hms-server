import { Router } from "express";
import { pool } from "../../../db"; // your existing PG pool
import { z } from "zod";

const router = Router();

// Validate incoming request body
const BillingSchema = z.object({
  tenant_id: z.string().uuid(),
  company_id: z.string().uuid(),
  created_by: z.string().uuid(),
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  prescription_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid(),
  items: z.array(
    z.object({
      product_id: z.string().uuid(),
      batch_id: z.string().uuid().nullable().optional(),
      quantity: z.number().positive(),
      unit_price: z.number().nonnegative(),
      discount_amount: z.number().nonnegative().optional().default(0),
      tax_rate: z.number().nonnegative().optional().default(0),
    })
  ),
  payment: z
    .object({
      amount: z.number().positive(),
      method: z.string(),
      reference: z.string().nullish(),
    })
    .optional()
    .nullable(),
});

// POST /api/hms/pharmacy/billing/fulfill
router.post("/fulfill", async (req, res, next) => {
  try {
    const idempotencyKey =
      req.headers["idempotency-key"] ||
      req.body.idempotency_key ||
      null;

    if (!idempotencyKey) {
      return res
        .status(400)
        .json({ error: "Idempotency-Key header is required" });
    }

    const parse = BillingSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "invalid_request",
        details: parse.error.flatten(),
      });
    }

    const body = parse.data;

    const result = await pool.query(
      `
      SELECT public.pharmacy_fulfill_order(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::jsonb,
        $9::jsonb,
        $10::text
      ) AS result;
    `,
      [
        body.tenant_id,
        body.company_id,
        body.created_by,
        body.patient_id,
        body.encounter_id,
        body.prescription_id,
        body.location_id,
        JSON.stringify(body.items),
        body.payment ? JSON.stringify(body.payment) : null,
        idempotencyKey,
      ]
    );

    return res.json({ ok: true, data: result.rows[0].result });
  } catch (err: any) {
    // Normalize Postgres errors
    if (err?.message?.includes("Insufficient stock")) {
      return res.status(409).json({ error: "stock_error", message: err.message });
    }

    if (err?.message?.includes("Invalid qty")) {
      return res.status(400).json({ error: "quantity_error", message: err.message });
    }

    return next(err); // pass to your global error handler
  }
});

export default router;
