// server/src/routes/ai_salt.ts
import { Router } from "express";
import { normalizeSalt } from "../services/drugInteractionService";
import OpenAI from "openai";

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * POST /ai/salt/extract
 * body: { file?: { base64, name, type }, text?: string }
 * returns: { salts: [...], raw_text, suggested_names }
 */
router.post("/ai/salt/extract", async (req, res) => {
  const { file, text } = req.body;

  // If text is provided, use that first
  let raw = text || "";

  if (file && file.base64) {
    // Use OpenAI vision/captioning to extract text from image
    // (If you prefer tesseract, swap in your OCR code)
    try {
      const imageData = `data:${file.type};base64,${file.base64}`;
      const prompt = `Extract product lines and active ingredients (salts) from this invoice image. Return JSON: { "text": "<extracted text>" }`;
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify([{ type: "input_image", image_url: imageData }]) },
        ],
      });
      raw = JSON.parse(r.choices[0].message.content).text || raw;
    } catch (e) {
      // fallback: leave raw as existing text
    }
  }

  // Heuristic extraction: look for patterns like "SaltName 500mg" or "Paracetamol (500 mg)"
  const salts: string[] = [];
  const lines = raw.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  for (const ln of lines) {
    const m = ln.match(/([A-Za-z0-9\-\s]+?)\s*(?:\(|,)\s*([0-9]+(?:mg|g|mcg|IU)|tablet|tab|cap|syrup)?/i);
    if (m) {
      let candidate = m[1];
      candidate = candidate.replace(/\d+/g, "").trim();
      if (candidate && candidate.length > 2) salts.push(normalizeSalt(candidate));
    }
    // also pick explicit "Salt:" patterns
    const m2 = ln.match(/salt[:\s]+([A-Za-z0-9\-\s]+)/i);
    if (m2) salts.push(normalizeSalt(m2[1]));
  }

  // Deduplicate + limit
  const uniq = Array.from(new Set(salts)).slice(0, 12);

  // As a safety, ask LLM to normalize names (optional)
  try {
    const r2 = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Normalize the following active ingredient names to canonical salt names." },
        { role: "user", content: JSON.stringify({ candidates: uniq }) },
      ],
    });
    const normalized = JSON.parse(r2.choices[0].message.content).normalized || uniq;
    return res.json({ salts: normalized, raw_text: raw });
  } catch (e) {
    return res.json({ salts: uniq, raw_text: raw });
  }
});

export default router;
