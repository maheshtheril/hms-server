// server/src/routes/ai_interactions.ts
import { Router } from "express";
import { ruleCheckInteractions, aiAssessInteractions } from "../services/drugInteractionService";

const router = Router();

/**
 * POST /ai/drug/interactions
 * body: { salts: ["paracetamol", "warfarin", ...] }
 */
router.post("/ai/drug/interactions", async (req, res) => {
  const { salts } = req.body;
  if (!salts || !Array.isArray(salts)) return res.status(400).json({ error: "salts array required" });

  // rule-based
  const ruleResults = ruleCheckInteractions(salts);
  if (ruleResults.length > 0) {
    return res.json({ interactions: ruleResults });
  }

  // fallback to AI
  const aiResults = await aiAssessInteractions(salts);
  return res.json({ interactions: aiResults });
});

export default router;
