// server/src/routes/ai_hsn.ts
import { Router } from "express";
import db from "../db";
import OpenAI from "openai";

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ------------------------------------------------------------------
   Medical HSN Map (seed) — You can extend later.
------------------------------------------------------------------ */
const HSN_RULES = [
  {
    match: ["paracetamol", "acetaminophen"],
    hsn: "30045090",
    gst: 12,
  },
  {
    match: ["ibuprofen"],
    hsn: "30049099",
    gst: 12,
  },
  {
    match: ["amoxicillin", "clavulanic", "augmentin"],
    hsn: "30042019",
    gst: 5,
  },
  {
    match: ["insulin"],
    hsn: "30043100",
    gst: 5,
  },
  {
    match: ["syringe", "disposable syringe", "needle"],
    hsn: "90183110",
    gst: 12,
  },
  {
    match: ["mask", "surgical mask"],
    hsn: "63079090",
    gst: 5,
  },
];

/* ------------------------------------------------------------------
   Function: ruleBasedHSN
------------------------------------------------------------------ */
function ruleBasedHSN(text: string) {
  const search = text.toLowerCase();

  for (const rule of HSN_RULES) {
    for (const kw of rule.match) {
      if (search.includes(kw)) {
        return {
          hsn: rule.hsn,
          gst: rule.gst,
          confidence: 0.85,
          source: "rule-engine",
        };
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------
   Function: aiPredictHSN
------------------------------------------------------------------ */
async function aiPredictHSN(input: any) {
  const prompt = `
You are an expert GST + HSN classifier for Indian pharmaceutical goods.

Given the following product details, return only JSON:
{
  "hsn": "...",
  "gst": ...,
  "confidence": 0.0
}

Base rules:
- Most medicines fall under 3004 series (5% or 12% GST)
- Surgical tools typically 9018 / 9019 / 9025
- Masks & disposables 6307

Be accurate and conservative.

Product:
${JSON.stringify(input, null, 2)}
`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
  });

  try {
    return JSON.parse(r.choices[0].message.content);
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------
   POST /ai/hsn — hybrid prediction
------------------------------------------------------------------ */
router.post("/ai/hsn", async (req, res) => {
  const input = req.body;

  // Combine text for rule engine
  const combined =
    (input.name || "") +
    " " +
    (input.salt || "") +
    " " +
    (input.category || "");

  // Step 1 — Rule engine
  const rule = ruleBasedHSN(combined);
  if (rule) return res.json(rule);

  // Step 2 — AI fallback
  const ai = await aiPredictHSN(input);

  if (!ai)
    return res.json({
      hsn: null,
      gst: null,
      confidence: 0.2,
      source: "unknown",
    });

  return res.json({
    ...ai,
    source: "ai-model",
  });
});

export default router;
