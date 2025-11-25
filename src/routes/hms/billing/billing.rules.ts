import { Router } from "express";
import { pool } from "../../../db";
import requireSession from "../../../middleware/requireSession";

const router = Router();

// Create billing rule
router.post("/rules", requireSession, async (req:any, res) => {
  try {
    const { item_type, item_id, price, tax_rate_id } = req.body;

    if (!item_type || !item_id || !price)
      return res.status(400).json({ error: "missing_fields" });

    const { tenant_id, company_id, user_id } = req.session;

    const r = await pool.query(
      `INSERT INTO hms_billing_rule
        (tenant_id, company_id, item_type, item_id, price, tax_rate_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [tenant_id, company_id, item_type, item_id, price, tax_rate_id, user_id]
    );

    return res.json({ ok: true, billing_rule_id: r.rows[0].id });
  } catch (err) {
    console.error("BILLING RULE ERROR:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

export default router;
