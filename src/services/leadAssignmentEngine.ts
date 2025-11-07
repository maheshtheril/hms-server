import db from "../db";

export async function autoAssignLead(leadId: string, pipelineId: string) {
  const rules = (await db.query(
    `SELECT * FROM public.lead_assignment_rule
     WHERE pipeline_id=$1 AND active=true
     ORDER BY priority ASC`,
    [pipelineId]
  )).rows;

  for (const rule of rules) {
    // Basic "always true" for placeholder; plug your logic on rule.criteria
    const ok = true;
    if (ok) {
      await db.query(`UPDATE public.lead SET owner_id=$1 WHERE id=$2`, [rule.assign_to, leadId]);
      await db.query(
        `INSERT INTO public.lead_assignment_history
         (id, tenant_id, lead_id, rule_id, from_owner, to_owner, reason, created_by, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, null, $4, 'auto-assigned', null, now())`,
        [rule.tenant_id, leadId, rule.id, rule.assign_to]
      );
      return rule.assign_to;
    }
  }
  return null;
}
