// server/src/services/ai.ts
import axios from 'axios';

/**
 * Lightweight AI helper that requests a short pre-visit summary / checklist.
 * Configure:
 *   AI_API_URL - HTTP endpoint for your LLM or AI service
 *   AI_API_KEY
 *
 * This function is intentionally small and times out quickly (5s) — keep heavy work out of request path.
 */

const AI_API_URL = process.env.AI_API_URL;
const AI_API_KEY = process.env.AI_API_KEY;

export async function generatePreVisitSummary({ patientName, clinicianName, reason, notes }: {
  patientName?: string;
  clinicianName?: string;
  reason?: string;
  notes?: string | null;
}): Promise<{ summary?: string; error?: string }> {
  if (!AI_API_URL || !AI_API_KEY) {
    return { error: 'ai_not_configured' };
  }

  // Simple prompt template — customize for your model
  const prompt = `Write a 2-3 line pre-visit checklist for patient "${patientName || 'Unknown'}" with clinician "${clinicianName || 'Clinician'}".
Reason: ${reason || 'general consult'}.
Notes: ${notes || ''}.
Keep it concise (max 60 words).`;

  try {
    const resp = await axios.post(
      AI_API_URL,
      { prompt, max_tokens: 120 },
      { headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 5000 }
    );
    // Accept different response shapes
    const text = resp.data?.text || resp.data?.choices?.[0]?.text || resp.data?.result || null;
    return { summary: (text || '').toString().trim() };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}
