// server/src/accounting/taxMaps.controller.ts
import db from "../db";

export default {
  list: async (req, res) => {
    const { tenant_id, company_id } = req.session;

    const r = await db.query(
      `SELECT ctm.*, tt.name AS tax_type_name, tr.name AS tax_rate_name, tr.rate
       FROM company_tax_maps ctm
       JOIN tax_types tt ON tt.id = ctm.tax_type_id
       JOIN tax_rates tr ON tr.id = ctm.tax_rate_id
       WHERE ctm.tenant_id=$1 AND ctm.company_id=$2
       ORDER BY tt.name, tr.rate`,
      [tenant_id, company_id]
    );
    res.json(r.rows);
  },

  create: async (req, res) => {
    const { tenant_id, company_id } = req.session;
    const { tax_type_id, tax_rate_id, account_id, refund_account_id } = req.body;

    const result = await db.query(`
      INSERT INTO company_tax_maps
      (tenant_id, company_id, tax_type_id, tax_rate_id, account_id, refund_account_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [tenant_id, company_id, tax_type_id, tax_rate_id, account_id, refund_account_id]
    );

    res.json(result.rows[0]);
  },

  update: async (req, res) => {
    const { tenant_id, company_id } = req.session;
    const { id } = req.params;
    const { tax_rate_id, account_id, refund_account_id, is_default, is_active } = req.body;

    const r = await db.query(`
      UPDATE company_tax_maps
      SET tax_rate_id=$1, account_id=$2, refund_account_id=$3, is_default=$4, is_active=$5
      WHERE id=$6 AND tenant_id=$7 AND company_id=$8
      RETURNING *`,
      [tax_rate_id, account_id, refund_account_id, is_default, is_active, id, tenant_id, company_id]
    );

    res.json(r.rows[0]);
  }
};
