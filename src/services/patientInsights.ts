// server/src/services/patientInsights.ts
/**
 * Lightweight insights service.
 * - computeInsights(patient) => { risk_score, gender_suggestion, anomalies[], timeline_summary }
 * - store results in hms_patient_insights (new table) for fast read
 *
 * Notes:
 * - This implementation supports pluggable model backends:
 *    - Local heuristic (default)
 *    - External LLM endpoint (OPENAI_API_KEY or INSIGHTS_API_URL) — you can wire your own provider
 *
 * - Keep compute idempotent and safe for retries.
 */

import db from "../db";
import fetch from "node-fetch";

type Patient = any;
type Insights = {
  id: string;
  patient_id: string;
  tenant_id: string;
  risk_score: number; // 0-100
  gender_suggestion?: string | null;
  anomalies: any[]; // list of alerts / anomaly objects
  timeline_summary?: string | null;
  computed_at: string;
};

function heuristicRiskScore(patient: Patient): number {
  // Simple heuristic: missing demographics & metadata increases risk; multiple identifiers increases confidence
  let score = 10;
  if (!patient.dob) score += 20;
  if (!patient.gender) score += 15;
  if (!patient.contact || Object.keys(patient.contact || {}).length === 0) score += 15;
  if (patient.identifiers && Object.keys(patient.identifiers).length >= 2) score -= 10;
  // age-based (if dob present)
  if (patient.dob) {
    const age = Math.floor((Date.now() - new Date(patient.dob).getTime()) / (1000 * 60 * 60 * 24 * 365.25));
    if (age >= 65) score += 10;
    if (age <= 2) score += 10;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return Math.round(score);
}

function heuristicGender(patient: Patient): string | null {
  // Very small heuristic: if identifiers include national registry with gender, else null
  try {
    const ids = patient.identifiers || {};
    if (ids?.national_id?.gender) return ids.national_id.gender;
    // fallback: common name suffix heuristic (very fuzzy)
    const fn = (patient.first_name || "").toLowerCase();
    if (fn.endsWith("a") && fn.length > 2) return "female";
  } catch (e) {}
  return null;
}

function detectAnomalies(patient: Patient): any[] {
  const anomalies: any[] = [];
  // conflicting DOB vs metadata.birth_year
  if (patient.metadata?.birth_year && patient.dob) {
    const dobYear = new Date(patient.dob).getFullYear();
    if (Number(patient.metadata.birth_year) !== dobYear) {
      anomalies.push({
        code: "dob_mismatch",
        title: "DOB mismatch",
        detail: `dob (${dobYear}) vs metadata.birth_year (${patient.metadata.birth_year})`,
      });
    }
  }
  // duplicate identifiers heuristic (two patients may have same national id — cross-check not implemented here)
  if (patient.identifiers) {
    const keys = Object.keys(patient.identifiers);
    if (keys.length === 0) anomalies.push({ code: "no_identifiers", title: "No identifiers", detail: "Patient has no identifiers" });
  }
  return anomalies;
}

async function callExternalLLMForSummary(patient: Patient): Promise<{ summary?: string; gender?: string | null; risk?: number } | null> {
  const apiKey = process.env.INSIGHTS_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.INSIGHTS_API_URL || process.env.OPENAI_API_URL;
  if (!apiKey || !endpoint) return null;

  const prompt = [
    "You are an assistant that summarizes a patient's profile in 30-60 words and estimates a risk score (0-100) for missing or inconsistent demographic/administrative data.",
    "Patient JSON:",
    JSON.stringify(patient),
    "Return a JSON object: { summary: string, gender: 'male'|'female'|'other'|null, risk: number } only."
  ].join("\n\n");

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        prompt,
        max_tokens: 256,
      }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    // Expect provider returns { summary, gender, risk } or wrap accordingly
    // Try multiple shapes:
    if (body?.summary && typeof body.risk === "number") return { summary: body.summary, gender: body.gender ?? null, risk: body.risk };
    if (body?.choices && Array.isArray(body.choices)) {
      // e.g., OpenAI text completion
      const text = body.choices[0]?.text || body.choices[0]?.message?.content || "";
      try {
        const parsed = JSON.parse(text);
        return { summary: parsed.summary, gender: parsed.gender ?? null, risk: parsed.risk };
      } catch (e) {
        // fallback: no parse
        return { summary: text.slice(0, 280), gender: null, risk: heuristicRiskScore(patient) };
      }
    }
    return null;
  } catch (err) {
    console.warn("LLM call failed:", err);
    return null;
  }
}

export async function computeAndStoreInsights(patient: Patient): Promise<Insights> {
  const tenant_id = patient.tenant_id;
  const patient_id = patient.id;
  const computed_at = new Date().toISOString();

  // compute heuristics
  let risk = heuristicRiskScore(patient);
  let gender_suggestion = heuristicGender(patient);
  const anomalies = detectAnomalies(patient);

  // try external LLM to refine (if configured) — non-blocking fallback
  const llm = await callExternalLLMForSummary(patient).catch(() => null);
  let timeline_summary = null;
  if (llm) {
    if (typeof llm.risk === "number") risk = Math.round(Math.max(0, Math.min(100, llm.risk)));
    if (llm.gender) gender_suggestion = llm.gender;
    timeline_summary = llm.summary ?? null;
  } else {
    // local timeline summary: basic template
    const parts = [];
    if (patient.dob) parts.push(`Born ${new Date(patient.dob).toLocaleDateString()}`);
    if (patient.patient_number) parts.push(`Patient #: ${patient.patient_number}`);
    timeline_summary = parts.join(" • ");
  }

  // persist to hms_patient_insights table (create if not exists)
  // Table schema suggested:
  // CREATE TABLE IF NOT EXISTS public.hms_patient_insights (
  //   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  //   tenant_id uuid NOT NULL,
  //   patient_id uuid NOT NULL,
  //   risk_score int NOT NULL,
  //   gender_suggestion text,
  //   anomalies jsonb DEFAULT '[]'::jsonb,
  //   timeline_summary text,
  //   computed_at timestamptz NOT NULL DEFAULT now()
  // );
  try {
    const upsertSql = `
      INSERT INTO public.hms_patient_insights
        (tenant_id, patient_id, risk_score, gender_suggestion, anomalies, timeline_summary, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (tenant_id, patient_id) DO UPDATE
        SET risk_score = EXCLUDED.risk_score,
            gender_suggestion = EXCLUDED.gender_suggestion,
            anomalies = EXCLUDED.anomalies,
            timeline_summary = EXCLUDED.timeline_summary,
            computed_at = EXCLUDED.computed_at
      RETURNING *;
    `;
    const params = [
      tenant_id,
      patient_id,
      risk,
      gender_suggestion,
      JSON.stringify(anomalies),
      timeline_summary,
      computed_at,
    ];
    const r = await db.query(upsertSql, params);
    const row = r.rows[0];
    return {
      id: row.id,
      patient_id,
      tenant_id,
      risk_score: row.risk_score,
      gender_suggestion: row.gender_suggestion,
      anomalies: row.anomalies || [],
      timeline_summary: row.timeline_summary,
      computed_at: row.computed_at,
    };
  } catch (err) {
    console.error("Failed to persist insights:", err);
    // return best-effort insights without persistence
    return {
      id: patient_id + "-volatile",
      patient_id,
      tenant_id,
      risk_score: risk,
      gender_suggestion,
      anomalies,
      timeline_summary,
      computed_at,
    };
  }
}
