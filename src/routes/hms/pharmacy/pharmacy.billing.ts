import { Router } from "express";
import { pool } from "../../../db";

const router = Router();

// Tiny UUID validator
const isUuid = (v: any) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const toNumber = (v: any) => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

function validateBillingBody(body: any): {
  valid: boolean;
  errors: Record<string, any>;
  body: any;
} {
  const errors: Record<string, any> = {};

  const requireUuid = (k: string) => {
    if (!isUuid(body?.[k])) {
      errors[k] = [`${k} is required and must be a valid UUID`];
    }
  };

  requireUuid("tenant_id");
  requireUuid("company_id");
  requireUuid("created_by");
  requireUuid("patient_id");
  requireUuid("location_id");

  // optional nullable UUIDs
  const optNullableUuid = (k: string) => {
    if (body?.[k] === undefined || body?.[k] === null) return;
    if (!isUuid(body[k])) errors[k] = [`${k} must be a valid UUID or null`];
  };

  optNullableUuid("encounter_id");
  optNullableUuid("prescription_id");

  // ITEMS
  if (!Array.isArray(body?.items) || body.items.length === 0) {
    errors["items"] = ["items must be a non-empty array"];
  } else {
    const itemErrors: Record<number, Record<string, string>> = {};

    body.items.forEach((it: any, idx: number) => {
      const ie: Record<string, string> = {};

      if (!isUuid(it?.product_id)) ie.product_id = "product_id must be a UUID";

      if (it?.batch_id !== undefined && it?.batch_id !== null && !isUuid(it.batch_id))
        ie.batch_id = "batch_id must be a UUID or null";

      const qty = toNumber(it?.quantity);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0)
        ie.quantity = "quantity must be a positive integer";

      const unitPrice = toNumber(it?.unit_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0)
        ie.unit_price = "unit_price must be a non-negative number";

      const discount =
        it?.discount_amount === undefined ? 0 : toNumber(it.discount_amount);
      if (!Number.isFinite(discount) || discount < 0)
        ie.discount_amount = "discount_amount must be a non-negative number";

      const tax =
        it?.tax_rate === undefined ? 0 : toNumber(it.tax_rate);
      if (!Number.isFinite(tax) || tax < 0)
        ie.tax_rate = "tax_rate must be a non-negative number";

      if (Object.keys(ie).length > 0) {
        itemErrors[idx] = ie;
      } else {
        // sanitized values
        body.items[idx] = {
          product_id: it.product_id,
          batch_id: it.batch_id ?? null,
          quantity: Math.trunc(qty),
          unit_price: unitPrice,
          discount_amount: discount,
          tax_rate: tax,
        };
      }
    });

    if (Object.keys(itemErrors).length > 0) {
      errors["items"] = ["one or more items are invalid"];
      errors["items_details"] = Object.entries(itemErrors).map(
        ([k, v]) => ({ index: Number(k), errors: v })
      );
    }
  }

  // PAYMENT (optional | nullable)
  if (body.payment !== undefined && body.payment !== null) {
    const p = body.payment;
    const pErr: Record<string, string> = {};

    const amount = toNumber(p?.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      pErr.amount = "amount must be a positive number";

    if (!p?.method || typeof p.method !== "string")
      pErr.method = "method is required and must be a string";

    if (p?.reference !== undefined && p?.reference !== null && typeof p.reference !== "string")
      pErr.reference = "reference must be a string or null";

    if (Object.keys(pErr).length > 0) {
      errors["payment"] = pErr;
    } else {
      body.payment = {
        amount,
        method: p.method,
        reference: p.reference ?? null,
      };
    }
  } else {
    body.payment = null;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    body,
  };
}

// ROUTE
router.post("/fulfill", async (req, res, next) => {
  try {
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ||
      (req.body?.idempotency_key as string | undefined) ||
      null;

    if (!idempotencyKey) {
      return res.status(400).json({
        error: "Idempotency-Key header is required",
      });
    }

    const incoming = JSON.parse(JSON.stringify(req.body)); // shallow safe clone
    const { valid, errors, body } = validateBillingBody(incoming);

    if (!valid) {
      return res.status(400).json({
        error: "invalid_request",
        details: errors,
      });
    }

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

    return res.json({
      ok: true,
      data: result.rows[0].result,
    });
  } catch (err: any) {
    if (err?.message?.includes("Insufficient stock")) {
      return res.status(409).json({
        error: "stock_error",
        message: err.message,
      });
    }

    if (err?.message?.includes("Invalid qty")) {
      return res.status(400).json({
        error: "quantity_error",
        message: err.message,
      });
    }

    return next(err);
  }
});

export default router;
