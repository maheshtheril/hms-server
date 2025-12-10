// server/src/routes/ai_schedule.ts
import { Router } from "express";
import OpenAI from "openai";

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/*
  RULE ENGINE — HIGH CONFIDENCE (based on Govt Schedule H/H1/X lists)
*/
const SCHEDULE_RULES = [
  { match: ["alprazolam", "diazepam", "lorazepam", "clonazepam"], schedule: "H", confidence: 0.95 },
  { match: ["amoxicillin", "ceftriaxone", "azithromycin", "co-amoxiclav"], schedule: "H1", confidence: 0.90 },
  { match: ["morphine", "methadone", "pethidine", "fentanyl"], schedule: "X", confidence: 0.99 },
  { match: ["tramadol"], schedule: "H1", confidence: 0.85 },
  { match: ["oxycodone"], schedule: "X", confidence: 0.99 },
  { match: ["codeine"], schedule: "H", confidence: 0.90 },
];

/*
  RULE ENGINE
*/
function ruleCheck(text: string) {
  const lower = text.toLowerCase();

  for (const r of SCHEDULE_RULES) {
    for (const kw of r.match) {
      if (lower.includes(kw)) {
        return {
          schedule: r.schedule,
          confidence: r.confidence,
          source: "rule-engine",
        };
      }
    }
  }

  return null;
}

/*
  AI FALLBACK
*/
async function aiPredictSchedule(input: any) {
  const prompt = `
You are an Indian drug schedule classification system.

Given a medicine name, salt composition, manufacturer:
Return JSON:
{
  "schedule": "H" | "H1" | "X" | "OTC",
  "confidence": 0-1
}

ONLY return JSON.
Be very accurate.
If unsure, return "OTC".
`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: JSON.stringify(input) },
    ],
  });

  try {
    return JSON.parse(r.choices[0].message.content);
  } catch {
    return { schedule: "OTC", confidence: 0.20 };
  }
}

/*
  MAIN ENDPOINT
*/
router.post("/ai/schedule", async (req, res) => {
  const input = req.body;

  // Combine for rule engine
  const text = `${input.name} ${input.salt || ""}`;

  // Step 1: Rule engine
  const rule = ruleCheck(text);
  if (rule) return res.json(rule);

  // Step 2: AI fallback
  const ai = await aiPredictSchedule(input);
  ai.source = "ai-model";

  return res.json(ai);
});

export default router;
