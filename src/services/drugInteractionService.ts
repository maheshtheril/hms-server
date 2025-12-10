// server/src/services/drugInteractionService.ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Seed interaction dataset (extend it from CSV/DB)
export const INTERACTIONS = [
  // pairwise interactions (high priority)
  { a: "warfarin", b: "aspirin", type: "major", summary: "Increased bleeding risk", details: "Concurrent use increases anticoagulant effect and bleeding risk", confidence: 0.95 },
  { a: "metformin", b: "contrast", type: "major", summary: "Risk of lactic acidosis", details: "Iodinated contrast can increase risk of lactic acidosis", confidence: 0.9 },
  { a: "amoxicillin", b: "methotrexate", type: "moderate", summary: "Increased methotrexate toxicity", details: "Penicillins can reduce renal clearance of methotrexate", confidence: 0.85 },
  { a: "ciprofloxacin", b: "tizanidine", type: "major", summary: "Excessive hypotension", details: "Ciprofloxacin increases tizanidine levels", confidence: 0.9 },
  { a: "ssri", b: "tramadol", type: "major", summary: "Serotonin syndrome risk", details: "Concurrent use can precipitate serotonin syndrome", confidence: 0.9 },
  // salts synonyms mapping can be extended in DB
];

// normalize salts (basic)
export function normalizeSalt(s: string) {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s*\(.*\)/, "");
}

// quick rule engine
export function ruleCheckInteractions(salts: string[]) {
  const normalized = salts.map(normalizeSalt);
  const results: any[] = [];

  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i], b = normalized[j];
      // direct lookup
      for (const rule of INTERACTIONS) {
        if ((rule.a === a && rule.b === b) || (rule.a === b && rule.b === a)) {
          results.push({
            type: rule.type,
            summary: rule.summary,
            details: rule.details,
            confidence: rule.confidence,
            source: "rule-engine",
            pair: [a, b],
          });
        }
      }
    }
  }
  return results;
}

// AI fallback for pairwise set
export async function aiAssessInteractions(salts: string[]) {
  const prompt = `
You are a clinical pharmacology assistant. Given the following list of salts/active ingredients:
${JSON.stringify(salts)}

Return JSON:
{
  "interactions": [
    { "pair": ["salt1","salt2"], "type":"major|moderate|minor|none", "summary":"...", "details":"...", "confidence":0.0 }
  ]
}

Be conservative. If uncertain, return type "unknown" with low confidence.
  `;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
  });

  try {
    const parsed = JSON.parse(r.choices[0].message.content);
    return parsed.interactions || [];
  } catch (e) {
    return [];
  }
}
