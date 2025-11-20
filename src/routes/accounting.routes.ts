// server/src/routes/accounting.routes.ts
import { Router } from "express";
import AccountsController from "../accounting/accounts.controller";
import JournalsController from "../accounting/journals.controller";
import JournalEntriesController from "../accounting/journalEntries.controller";
import PostingController from "../accounting/posting.controller";
import TaxMapsController from "../accounting/taxMaps.controller";
// server/src/routes/accounting.routes.ts (append)
import PaymentController from "../controllers/payment.controller";

const router = Router();

router.get("/accounts", AccountsController.list);
router.post("/accounts", AccountsController.create);

router.get("/journals", JournalsController.list);
router.post("/journals", JournalsController.create);

router.get("/journal-entries", JournalEntriesController.list);
router.get("/journal-entries/:id", JournalEntriesController.getById);

router.post("/post/invoice", PostingController.postInvoice);

router.get("/tax-maps", TaxMapsController.list);
router.post("/tax-maps", TaxMapsController.create);
router.put("/tax-maps/:id", TaxMapsController.update);

router.post("/payments/post", PaymentController.postPayment);
router.get("/payments", PaymentController.list);

export default router;
