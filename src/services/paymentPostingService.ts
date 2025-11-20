// server/src/services/paymentPostingService.ts
import db from "../db";

type AuthContext = {
  tenant_id: string;
  company_id: string;
  user_id?: string | null;
};

type PaymentLineInput = {
  invoice_id?: string | null; // optional
  amount: string | number;    // company currency amount
};

export class PaymentPostingService {
  /**
   * Post a payment with FIFO partial allocation to invoices.
   *
   * - auth: tenant/company/user
   * - payload: { payment_number?, partner_id?, journal_id?, method?, reference?, currency_id?, lines: [{invoice_id?, amount}], type: 'customer'|'vendor', bank_account_id? }
   * - clientOptional: pass a PoolClient (req.dbClient) to ensure set_config RLS works
   */
  static async postPayment(
    auth: AuthContext,
    payload: {
      payment_number?: string | null;
      partner_id?: string | null;
      journal_id?: string | null;
      method?: string | null;
      reference?: string | null;
      currency_id?: string | null;
      lines: PaymentLineInput[];
      type: "customer" | "vendor";
      bank_account_id?: string | null;
    },
    clientOptional?: any
  ) {
    const client = clientOptional ?? db;
    const q = async (sql: string, params?: any[]) => (client as any).query(sql, params);

    // begin tx
    await q("BEGIN");
    try {
      // Idempotency: if payment_number provided, try to find existing payment for this tenant
      let existingPayment = null;
      if (payload.payment_number) {
        const pn = (payload.payment_number || "").toLowerCase();
        const found = await q(
          `SELECT * FROM public.payments WHERE tenant_id = $1 AND payment_number_normalized = $2 LIMIT 1`,
          [auth.tenant_id, pn]
        );
        existingPayment = found.rows[0];
        if (existingPayment) {
          await q("ROLLBACK");
          return existingPayment; // idempotent return
        }
      }

      // compute total amount (sum of provided lines)
      const totalAmount = payload.lines.reduce((s, l) => s + Number(l.amount), 0);

      // create payment header
      const insPay = await q(
        `INSERT INTO public.payments
          (tenant_id, company_id, payment_number, payment_number_normalized, partner_id, journal_id, method, amount, currency_id, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          auth.tenant_id,
          auth.company_id,
          payload.payment_number ?? null,
          payload.payment_number ? (payload.payment_number.toLowerCase()) : null,
          payload.partner_id ?? null,
          payload.journal_id ?? null,
          payload.method ?? null,
          totalAmount,
          payload.currency_id ?? null,
          payload.reference ?? null,
          auth.user_id ?? null
        ]
      );
      const payment = insPay.rows[0];

      // pick bank journal (same logic as earlier)
      let journalId = payload.journal_id;
      if (!journalId) {
        const r = await q(
          `SELECT id FROM public.journals WHERE company_id = $1 AND type IN ('bank','cash') LIMIT 1`,
          [auth.company_id]
        );
        journalId = r.rows[0]?.id ?? null;
      }

      // create journal entry header
      const jeRes = await q(
        `INSERT INTO public.journal_entries (tenant_id, company_id, journal_id, date, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [auth.tenant_id, auth.company_id, journalId, (new Date()).toISOString().slice(0,10), payload.reference ?? payload.payment_number ?? null, auth.user_id ?? null]
      );
      const journalEntry = jeRes.rows[0];

      // helper to insert journal entry line
      const insertJEL = async (jeId: string, accountId: string, debit: number, credit: number, partnerId?: string | null) => {
        const res = await q(
          `INSERT INTO public.journal_entry_lines
            (tenant_id, company_id, journal_entry_id, account_id, debit, credit, partner_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING *`,
          [auth.tenant_id, auth.company_id, jeId, accountId, debit, credit, partnerId ?? null]
        );
        return res.rows[0];
      };

      // helper to get invoice header with outstanding
      const getInvoiceData = async (invoiceId: string) => {
        const r = await q(
          `SELECT i.id, i.tenant_id, i.company_id, i.type, COALESCE(i.total,0)::numeric AS total, COALESCE(i.outstanding,0)::numeric AS outstanding, i.posted, i.ar_account_id, i.ap_account_id, je.id as invoice_journal_entry_id
           FROM public.invoices i
           LEFT JOIN public.journal_entries je ON je.invoice_id = i.id
           WHERE i.id = $1 AND i.tenant_id = $2 AND i.company_id = $3
           LIMIT 1`,
          [invoiceId, auth.tenant_id, auth.company_id]
        );
        return r.rows[0];
      };

      // helper: find bank account id from journal
      const getBankAccountByJournal = async (jid?: string | null) => {
        if (payload.bank_account_id) return payload.bank_account_id;
        if (!jid) return null;
        const r = await q(`SELECT default_debit_account_id AS bank_account FROM public.journals WHERE id = $1 LIMIT 1`, [jid]);
        return r.rows[0]?.bank_account ?? null;
      };

      const bankAccountId = await getBankAccountByJournal(journalEntry.journal_id);
      if (!bankAccountId) {
        // try suspense fallback
        const r = await q(`SELECT id FROM public.accounts WHERE company_id = $1 AND code = '9990' LIMIT 1`, [auth.company_id]);
        if (!r.rows[0]) throw new Error("No bank account and no suspense account (code 9990) available.");
      }

      // store created payment_line ids for later (and total applied)
      const paymentLineRows: any[] = [];

      // ALLOCATION LOGIC:
      // For each payload line: if invoice_id provided, apply to that invoice (up to outstanding).
      // If no invoice_id provided: treat as bank-only deposit (suspense) — we already create lines for those.
      for (const inputLine of payload.lines) {
        let remaining = Number(inputLine.amount);
        if (remaining <= 0) throw new Error("Payment line amount must be > 0");

        if (inputLine.invoice_id) {
          // apply to the specified invoice (can be partial)
          let inv = await getInvoiceData(inputLine.invoice_id);
          if (!inv) throw new Error(`Invoice ${inputLine.invoice_id} not found`);
          if (!inv.posted) throw new Error(`Invoice ${inputLine.invoice_id} is not posted; post it before payment`);

          // allocate amount to this invoice (we don't auto-apply across other invoices)
          const toApply = Math.min(remaining, Number(inv.outstanding || inv.total || 0));
          if (toApply <= 0) {
            // nothing to apply - insert zero? skip
            continue;
          }

          // create payment_lines entry pointing to invoice with the applied amount (not the requested amount)
          const plRes = await q(
            `INSERT INTO public.payment_lines (tenant_id, company_id, payment_id, invoice_id, invoice_journal_entry_id, amount, created_at)
             VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
            [auth.tenant_id, auth.company_id, payment.id, inputLine.invoice_id, inv.invoice_journal_entry_id ?? null, toApply]
          );
          const paymentLine = plRes.rows[0];
          paymentLineRows.push(paymentLine);

          // create corresponding journal lines:
          // Customer payment: debit bank, credit AR
          // Vendor payment: debit AP, credit bank (we implement symmetric)
          if (payload.type === 'customer') {
            const bankLine = await insertJEL(journalEntry.id, bankAccountId, toApply, 0, payload.partner_id ?? null);
            const arLine = await insertJEL(journalEntry.id, inv.ar_account_id, 0, toApply, payload.partner_id ?? null);
            // store ids if needed
            // record reconciliation detail: payment -> invoice mapping with amount
            await q(
              `INSERT INTO public.payment_reconciliation_details (tenant_id, company_id, payment_id, payment_line_id, invoice_id, amount, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [auth.tenant_id, auth.company_id, payment.id, paymentLine.id, inv.id, toApply, auth.user_id ?? null]
            );
          } else {
            // vendor
            const apLine = await insertJEL(journalEntry.id, inv.ap_account_id, toApply, 0, payload.partner_id ?? null);
            const bankLine = await insertJEL(journalEntry.id, bankAccountId, 0, toApply, payload.partner_id ?? null);
            await q(
              `INSERT INTO public.payment_reconciliation_details (tenant_id, company_id, payment_id, payment_line_id, invoice_id, amount, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [auth.tenant_id, auth.company_id, payment.id, paymentLine.id, inv.id, toApply, auth.user_id ?? null]
            );
          }

          // update invoice outstanding and state
          const newOutstanding = Number(inv.outstanding) - toApply;
          const newState = newOutstanding <= 0 ? 'paid' : (newOutstanding < Number(inv.total) ? 'partially_paid' : 'open');
          await q(`UPDATE public.invoices SET outstanding=$1, state=$2, updated_at=now() WHERE id=$3`, [newOutstanding, newState, inv.id]);

          // optionally mark invoice fully paid flag if needed
          // continue; (we applied for this invoice)
        } else {
          // No invoice_id: bank-only deposit/withdrawal -> create bank and suspense lines
          const toApply = remaining;
          if (payload.type === 'customer') {
            const bankLine = await insertJEL(journalEntry.id, bankAccountId, toApply, 0, payload.partner_id ?? null);
            // balancing suspense
            const s = await q(`SELECT id FROM public.accounts WHERE company_id = $1 AND code='9990' LIMIT 1`, [auth.company_id]);
            const suspenseId = s.rows[0]?.id;
            if (!suspenseId) throw new Error("Missing suspense account (9990) for bank-only payment");
            const suspLine = await insertJEL(journalEntry.id, suspenseId, 0, toApply, null);
            // insert payment_lines pointing to null invoice (bank-only)
            const plRes = await q(
              `INSERT INTO public.payment_lines (tenant_id, company_id, payment_id, invoice_id, invoice_journal_entry_id, amount, created_at)
               VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
              [auth.tenant_id, auth.company_id, payment.id, null, null, toApply]
            );
            const paymentLine = plRes.rows[0];
            paymentLineRows.push(paymentLine);
            await q(
              `INSERT INTO public.payment_reconciliation_details (tenant_id, company_id, payment_id, payment_line_id, invoice_id, amount, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [auth.tenant_id, auth.company_id, payment.id, paymentLine.id, null, toApply, auth.user_id ?? null]
            );
          } else {
            // vendor payout bank-only
            const s = await q(`SELECT id FROM public.accounts WHERE company_id = $1 AND code='9990' LIMIT 1`, [auth.company_id]);
            const suspenseId = s.rows[0]?.id;
            if (!suspenseId) throw new Error("Missing suspense account (9990) for bank-only payment");
            const suspLine = await insertJEL(journalEntry.id, suspenseId, toApply, 0, null);
            const bankLine = await insertJEL(journalEntry.id, bankAccountId, 0, toApply, payload.partner_id ?? null);
            const plRes = await q(
              `INSERT INTO public.payment_lines (tenant_id, company_id, payment_id, invoice_id, invoice_journal_entry_id, amount, created_at)
               VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *`,
              [auth.tenant_id, auth.company_id, payment.id, null, null, toApply]
            );
            const paymentLine = plRes.rows[0];
            paymentLineRows.push(paymentLine);
            await q(
              `INSERT INTO public.payment_reconciliation_details (tenant_id, company_id, payment_id, payment_line_id, invoice_id, amount, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [auth.tenant_id, auth.company_id, payment.id, paymentLine.id, null, toApply, auth.user_id ?? null]
            );
          }
        } // end if inputLine.invoice_id
      } // end for lines

      // Validate journal balancing
      const totalsRes = await q(
        `SELECT COALESCE(SUM(debit),0)::numeric AS debit_total, COALESCE(SUM(credit),0)::numeric AS credit_total
         FROM public.journal_entry_lines WHERE journal_entry_id = $1`,
        [journalEntry.id]
      );
      const { debit_total, credit_total } = totalsRes.rows[0];
      if (Number(debit_total).toFixed(6) !== Number(credit_total).toFixed(6)) {
        throw new Error(`Payment journal entry not balanced: debit=${debit_total} credit=${credit_total}`);
      }

      // Post JE
      await q(`UPDATE public.journal_entries SET posted=true, posted_at=now(), updated_at=now() WHERE id=$1`, [journalEntry.id]);

      // Update payment record: posted and link journal_entry
      await q(`UPDATE public.payments SET posted=true, posted_at=now(), journal_entry_id=$2, updated_at=now() WHERE id=$1`, [payment.id, journalEntry.id]);

      // Commit
      await q("COMMIT");

      // return the new payment with reconciliation detail summary
      const final = await q(`SELECT p.*, (SELECT json_agg(pr.*) FROM public.payment_reconciliation_details pr WHERE pr.payment_id = p.id) as allocations FROM public.payments p WHERE p.id = $1`, [payment.id]);
      return final.rows[0];
    } catch (err) {
      try { await q("ROLLBACK"); } catch (_) {}
      throw err;
    }
  }
}
