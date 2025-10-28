// server/src/lib/ai.ts
// Minimal shim for AI hooks — replace with real integration when ready (OpenAI, internal LLM service, queue, etc.)
export async function callAi(action: string, payload: any): Promise<any> {
  // Example: action could be "generate_patient_summary", "patient.created"
  // In production, this should enqueue a job (Redis/RQ/Bull/Jobs) or call a microservice.
  // For now return a tiny synthetic summary for dev/testing.
  if (action === "generate_patient_summary") {
    const patient = payload.patient;
    const name = `${patient.first_name || ""} ${patient.last_name || ""}`.trim();
    return `Patient ${name} — Age/DoB: ${patient.dob || "n/a"}, Gender: ${patient.gender || "n/a"}. Generated summary (dev).`;
  }

  // async no-op stub
  return Promise.resolve({ ok: true });
}
