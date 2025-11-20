// server/src/accounting/accounts.controller.ts
import db from "../db";

export default {
  list: async (req, res) => {
    const { tenant_id, company_id } = req.session;
    const result = await db.query(
      `SELECT * FROM accounts
       WHERE tenant_id=$1 AND company_id=$2
       ORDER BY code`,
      [tenant_id, company_id]
    );
    res.json(result.rows);
  },

  create: async (req, res) => {
    const { code, name, type } = req.body;
    const { tenant_id, company_id } = req.session;

    const result = await db.query(
      `INSERT INTO accounts (tenant_id, company_id, code, name, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenant_id, company_id, code, name, type]
    );

    res.json(result.rows[0]);
  }
};
