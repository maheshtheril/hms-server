// server/src/controllers/payment.controller.ts
import db from "../db";                // ✅ ADD THIS
import { PaymentPostingService } from "../services/paymentPostingService";

export default {
  postPayment: async (req: any, res: any) => {
    try {
      const auth = req.authSession ?? {
        tenant_id: req.body.tenant_id,
        company_id: req.body.company_id,
        user_id: req.user?.id,
      };

      if (!auth.tenant_id || !auth.company_id) {
        return res.status(403).json({ error: "missing auth context" });
      }

      const client = req.dbClient ?? undefined;
      const posted = await PaymentPostingService.postPayment(auth, req.body, client);

      return res.json({ success: true, payment: posted });
    } catch (err: any) {
      console.error("postPayment error:", err);
      return res.status(400).json({ error: err?.message ?? String(err) });
    }
  },

  list: async (req: any, res: any) => {
    const auth = req.authSession ?? {};
    const client = req.dbClient ?? db;   // now 'db' is defined
    const r = await client.query(
      `SELECT * FROM public.payments 
       WHERE tenant_id=$1 AND company_id=$2 
       ORDER BY created_at DESC LIMIT 200`,
      [auth.tenant_id, auth.company_id]
    );
    return res.json(r.rows);
  },
};
