import db from "../db";

function evaluateCondition(_cond: any, _lead: any) {
  // TODO: implement DSL; for now accept all
  return true;
}

async function sendNotification(_userId: string, _payload: any) {
  // stub; integrate with your notification system
  return;
}

export async function runWorkflows(triggerType: string, lead: any) {
  const flows = (await db.query(
    `SELECT * FROM workflow WHERE tenant_id=$1 AND trigger=$2 AND active=true`,
    [lead.tenant_id, triggerType]
  )).rows;
  for (const wf of flows) {
    if (!evaluateCondition(wf.condition, lead)) continue;
    switch (wf.action?.type) {
      case "create_task":
        await db.query(
          `INSERT INTO public.lead_task
           (id, tenant_id, lead_id, title, due_date, status, created_by, created_at, company_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'open', $5, now(), $6)`,
          [lead.tenant_id, lead.id, wf.action.title, wf.action.due_date, wf.action.created_by, lead.company_id]
        );
        break;
      case "notify_user":
        await sendNotification(wf.action.user_id, { type: "workflow", message: wf.action.message, lead_id: lead.id });
        break;
    }
  }
}
