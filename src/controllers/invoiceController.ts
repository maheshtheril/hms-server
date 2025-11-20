import { InvoicePostingService } from "../services/invoicePostingService";

export async function postInvoice(req, res) {
  try {
    const je = await InvoicePostingService.postInvoice(
      req.params.id,
      req.authSession
    );
    return res.json({ success: true, journal_entry: je });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
}
