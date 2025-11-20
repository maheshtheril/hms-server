// server/src/accounting/posting.controller.ts
import db from "../db";

export default {
  postInvoice: async (req, res) => {
    const { tenant_id, company_id } = req.session;
    const { journal_id, ref, lines, type } = req.body;

    try {
      const r = await db.query(
        `SELECT fn_post_invoice_lines($1, $2, $3, $4, $5::jsonb, $6) AS result`,
        [tenant_id, company_id, journal_id, ref, JSON.stringify(lines), type]
      );

      res.json({ success: true, entry: r.rows[0].result });

    } catch (err) {
      console.error("Posting error:", err);
      res.status(400).json({ error: err.message });
    }
  }
};
