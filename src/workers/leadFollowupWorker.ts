import db from "../db";

export async function runLeadFollowupWorker() {
  const rows = (await db.query(
    `SELECT lf.*, l.name as lead_name, l.owner_id
     FROM public.lead_followups lf
     JOIN public.lead l ON l.id = lf.lead_id
     WHERE lf.status='planned'
       AND lf.due_at < now() + interval '15 minutes'
       AND lf.due_at > now() - interval '10 minutes'`
  )).rows;

  for (const f of rows) {
    await db.query(
      `INSERT INTO public.lead_timeline (id, lead_id, type, content, created_at)
       VALUES (gen_random_uuid(), $1, 'reminder', $2, now())`,
      [f.lead_id, `Follow-up due: ${f.due_at} for lead ${f.lead_name}`]
    );
  }
}
