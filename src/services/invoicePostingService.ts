import db from "../db";

export class InvoicePostingService {

  /**
   * Post an invoice into accounting system.
   * Creates journal_entry + journal_lines.
   * Enforces double-entry balance.
   */
  static async postInvoice(invoiceId: string, userContext: any) {
    const { tenant_id, company_id } = userContext;

    // fetch invoice, lines, taxes, accounts
    const inv = await db.query(`
      SELECT * FROM invoices
      WHERE id=$1 AND tenant_id=$2 AND company_id=$3
    `, [invoiceId, tenant_id, company_id]).then(r => r.rows[0]);

    if (!inv) throw new Error("Invoice not found");

    if (inv.posted)
      throw new Error("Invoice already posted");

    // fetch invoice lines
    const lines = await db.query(`
      SELECT * FROM invoice_lines
      WHERE invoice_id=$1
    `, [invoiceId]).then(r => r.rows);

    if (lines.length === 0)
      throw new Error("Invoice has no lines");

    // decide journal type
    const journalId = inv.type === "customer_invoice"
      ? inv.sales_journal_id
      : inv.purchase_journal_id;

    // 1) create journal entry header
    const je = await db.query(`
      INSERT INTO journal_entries
      (tenant_id, company_id, invoice_id, journal_id, date, reference)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [
      tenant_id,
      company_id,
      invoiceId,
      journalId,
      inv.invoice_date,
      inv.number
    ]).then(r => r.rows[0]);

    let totalDebit = 0;
    let totalCredit = 0;

    // 2) Generate journal lines from invoice lines
    for (const l of lines) {

      // Revenue or Expense account
      const accountId = inv.type === "customer_invoice"
        ? l.income_account_id   // CR revenue
        : l.expense_account_id; // DR expense

      const amount = Number(l.subtotal); // line total without tax

      if (inv.type === "customer_invoice") {
        await this.addLine(je.id, accountId, 0, amount); // CREDIT revenue
        totalCredit += amount;
      } else {
        await this.addLine(je.id, accountId, amount, 0); // DEBIT expense
        totalDebit += amount;
      }

      // handle taxes
      if (l.tax_rate_id) {
        const tax = await db.query(`
          SELECT * FROM tax_rates WHERE id=$1
        `, [l.tax_rate_id]).then(r => r.rows[0]);

        if (!tax) throw new Error("Tax not found");

        const taxAmt = Number(l.subtotal) * (Number(tax.rate) / 100);

        if (inv.type === "customer_invoice") {
          // CREDIT tax payable
          await this.addLine(je.id, tax.payable_account_id, 0, taxAmt);
          totalCredit += taxAmt;
        } else {
          // DEBIT tax receivable
          await this.addLine(je.id, tax.receivable_account_id, taxAmt, 0);
          totalDebit += taxAmt;
        }
      }
    }

    // 3) Add AR/AP line
    const total = Number(inv.total);

    if (inv.type === "customer_invoice") {
      // DEBIT accounts receivable
      await this.addLine(je.id, inv.ar_account_id, total, 0);
      totalDebit += total;
    } else {
      // CREDIT accounts payable
      await this.addLine(je.id, inv.ap_account_id, 0, total);
      totalCredit += total;
    }

    // 4) Validate double-entry
    if (totalDebit.toFixed(2) !== totalCredit.toFixed(2)) {
      throw new Error(`Unbalanced entry: DR=${totalDebit} CR=${totalCredit}`);
    }

    // 5) Mark invoice posted
    await db.query(`
      UPDATE invoices
      SET posted=true, posted_at=now()
      WHERE id=$1
    `, [invoiceId]);

    await db.query(`
      UPDATE journal_entries
      SET posted=true, posted_at=now()
      WHERE id=$1
    `, [je.id]);

    return je;
  }

  static async addLine(jeId: string, accountId: string, debit: number, credit: number) {
    return db.query(`
      INSERT INTO journal_lines
      (journal_entry_id, account_id, debit, credit)
      VALUES ($1,$2,$3,$4)
    `, [jeId, accountId, debit, credit]);
  }
}
