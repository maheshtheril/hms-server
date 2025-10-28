/**
 * Lightweight insights service (Node 18+ native fetch)
 * - computeInsights(patient) => { risk_score, gender_suggestion, anomalies[], timeline_summary }
 * - Stores results in hms_patient_insights for fast reads
 */

import db from "../db";

type Patient = any;
type Insights = {
  id: string;
  patient_id: string;
  tenant_id: string;
  risk_score: number;
  gender_suggestion?: string | null;
  anomalies: any[];
  timeline_summary?: string | null;
  computed_at: string;
};

/* ----------------------------- Heuristics ---------------------------- */

function heuristicRiskScore(patient: Patient): number {
  let score = 10;
  if (!patient.dob) score += 20;
  if (!patient.gender) score += 15;
  if (!patient.contact || Object.keys(patient.contact || {}).length === 0) score += 15;
  if (patient.identifiers && Object.keys(patient.identifiers).length >= 2) score -= 10;

  if (patient.dob) {
    const age = Math.floor((Date.now() - new Date(patient.dob).getTime()) / (1000 * 60 * 60 * 24 * 365.25));
    if (age >= 65) score += 10;
    if (age <= 2) score += 10;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function heuristicGender(patient: Patient): string | null {
  try {
    const ids = patient.identifiers || {};
    if (ids?.national_id?.gender) return ids.national_id.gender;
    const fn = (patient.first_name || "").toLowerCase();
    if (fn.endsWith("a") && fn.length > 2) return "female";
  } catch {}
  return null;
}

function detectAnomalies(patient: Patient): any[] {
  const anomalies: any[] = [];
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
  if (!patient.identifiers || Object.keys(patient.identifiers).length === 0) {
    anomalies.push({ code: "no_identifiers", title: "No identifiers", detail: "Patient has no identifiers" });
  }
  return anomalies;
}

/* ----------------------------- External LLM --------------------------- */

const EXTERNAL_ALLOWED = String(process.env.INSIGHTS_ALLOW_EXTERNAL || "false").toLowerCase() === "true";

async function callExternalLLMForSummary(
  patient: Patient
): Promise<{ summary?: string; gender?: string | null; risk?: number } | null> {
  if (!EXTERNAL_ALLOWED) return null;

  const apiKey = process.env.INSIGHTS_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.INSIGHTS_API_URL || process.env.OPENAI_API_URL;
  if (!apiKey || !endpoint) return null;

  const safePatient = { ...patient };
  if (safePatient.notes) safePatient.notes = "[redacted]";

  const prompt = [
    "You are an assistant that summarizes a patient's profile in 30–60 words and estimates a risk score (0–100) for missing or inconsistent demographic data.",
    "Patient JSON:",
    JSON.stringify(safePatient),
    "Return a JSON object: { summary: string, gender: 'male'|'female'|'other'|null, risk: number } only."
  ].join("\n\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ prompt, max_tokens: 256 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;

    const body = await resp.json();
    if (body?.summary && typeof body.risk === "number") {
      return { summary: body.summary, gender: body.gender ?? null, risk: body.risk };
    }
    if (Array.isArray(body?.choices)) {
      const text = body.choices[0]?.text || body.choices[0]?.message?.content || "";
      try {
        const parsed = JSON.parse(text);
        return { summary: parsed.summary, gender: parsed.gender ?? null, risk: parsed.risk };
      } catch {
        return { summary: text.slice(0, 280), gender: null, risk: heuristicRiskScore(patient) };
      }
    }
    return null;
  } catch (err: any) {
    if (err?.name === "AbortError") console.warn("LLM call timed out");
    else console.warn("LLM call failed:", err.message ?? err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* ----------------------------- Main Function -------------------------- */

export async function computeAndStoreInsights(patient: Patient): Promise<Insights> {
  const tenant_id = patient.tenant_id;
  const patient_id = patient.id;
  const computed_at = new Date().toISOString();

  let risk = heuristicRiskScore(patient);
  let gender_suggestion = heuristicGender(patient);
  const anomalies = detectAnomalies(patient);

  const llm = await callExternalLLMForSummary(patient).catch(() => null);
  let timeline_summary: string | null = null;

  if (llm) {
    if (typeof llm.risk === "number") risk = Math.round(Math.max(0, Math.min(100, llm.risk)));
    if (llm.gender) gender_suggestion = llm.gender;
    timeline_summary = llm.summary ?? null;
  } else {
    const parts = [];
    if (patient.dob) parts.push(`Born ${new Date(patient.dob).toLocaleDateString()}`);
    if (patient.patient_number) parts.push(`Patient #: ${patient.patient_number}`);
    timeline_summary = parts.join(" • ");
  }

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
  } catch (err: any) {
    console.error("Failed to persist insights:", err.message ?? err);
    return {
      id: `${patient_id}-volatile`,
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
