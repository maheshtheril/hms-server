// server/src/accounting/journalEntries.controller.ts
import db from "../db";

export default {
  list: async (req, res) => {
    const { tenant_id, company_id } = req.session;

    const r = await db.query(
      `SELECT je.*, j.code AS journal_code
       FROM journal_entries je
       LEFT JOIN journals j ON j.id = je.journal_id
       WHERE je.tenant_id=$1 AND je.company_id=$2
       ORDER BY je.date DESC, je.created_at DESC
       LIMIT 200`,
      [tenant_id, company_id]
    );

    res.json(r.rows);
  },

  getById: async (req, res) => {
    const { tenant_id, company_id } = req.session;
    const { id } = req.params;

    const header = await db.query(
      `SELECT * FROM journal_entries
       WHERE id=$1 AND tenant_id=$2 AND company_id=$3`,
      [id, tenant_id, company_id]
    );

    const lines = await db.query(
      `SELECT jel.*, a.code AS account_code, a.name AS account_name
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id=$1
       ORDER BY jel.created_at`,
      [id]
    );

    res.json({ header: header.rows[0], lines: lines.rows });
  }
};
