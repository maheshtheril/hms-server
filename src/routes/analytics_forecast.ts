import { Router } from "express";
import { forecastDemand } from "../services/forecast";

const router = Router();

router.get("/analytics/forecast/:productId", async (req, res) => {
  try {
    const r = await forecastDemand(req.params.productId);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
