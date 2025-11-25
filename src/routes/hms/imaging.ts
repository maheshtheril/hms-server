import { Router } from "express";
import imagingOrdersRouter from "./imaging/imaging.orders";
import imagingStudiesRouter from "./imaging/imaging.studies";
// import other imaging routers if you create them, e.g. imaging.series, imaging.images

const router = Router();

/**
 * Mount sub-routers:
 * - POST /api/hms/imaging/orders    -> imagingOrdersRouter
 * - GET  /api/hms/imaging/studies   -> imagingStudiesRouter
 *
 * When this file is imported as "./routes/hms/imaging", it returns this router.
 */
router.use("/orders", imagingOrdersRouter);     // expects imaging.orders.ts to export default router
router.use("/studies", imagingStudiesRouter);   // expects imaging.studies.ts to export default router

// Optional root endpoint for quick health check
router.get("/", (_req, res) => res.json({ ok: true, where: "hms/imaging root" }));

export default router;
