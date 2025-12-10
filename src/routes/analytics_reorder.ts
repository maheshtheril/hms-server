import { Router } from "express";
import { reorderSuggestion } from "../services/reorder";

const router = Router();

router.get("/analytics/reorder/:productId", async (req, res) => {
  try {
    const r = await reorderSuggestion(req.params.productId);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
