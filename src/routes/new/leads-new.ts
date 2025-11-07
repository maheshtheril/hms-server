import { Router } from "express";
import { z } from "zod";
import db from "../../db";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const leadsNewRouter = Router();

/* =====================
   Schemas
===================== */
const FollowupSchema = z.object({
  enabled: z.boolean().default(true),
  due_at: z.string().optional(),  // timestamptz
  note: z.string().optional()
}).optional();

const NoteSchema = z.object({
  enabled: z.boolean().default(true),
  body: z.string().min(1),
  visibility: z.enum(["internal","public"]).default("internal")
}).optional();

const TaskSchema = z.object({
  enabled: z.boolean().default(true),
  title: z.string().min(1),
  due_date: z.string().optional(),  // YYYY-MM-DD
  status: z.enum(["open","done","cancelled"]).default("open"),
  assigned_to: z.string().uuid().nullable().optional()
}).optional();

const LeadCreateSchema = z.object({
  tenant_id: z.string().uuid(),
  company_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  pipeline_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  name: z.string().min(2),
  primary_email: z.string().email().optional().or(z.literal("")),
  primary_phone: z.string().optional().or(z.literal("")),
  source_id: z.string().uuid().nullable().optional(),
  status: z.string().default("new"),
  estimated_value: z.coerce.number().default(0),
  probability: z.coerce.number().min(0).max(100).default(0),
  priority: z.coerce.number().min(1).max(5).default(3),
  custom_data: z.record(z.any()).default({}),
  tags: z.array(z.string()).default([]),
  meta: z.record(z.any()).default({}),
  metadata: z.record(z.any()).default({}),
  profession_id: z.string().uuid().nullable().optional(),
  profession_name: z.string().optional(),
  industry_id: z.string().uuid().nullable().optional(),
  followup: FollowupSchema,
  note: NoteSchema,
  task: TaskSchema,
  dry_run: z.boolean().optional(),
});

const LeadUpdateSchema = z.object({
  name: z.string().optional(),
  primary_email: z.string().optional(),
  primary_phone: z.string().optional(),
  source_id: z.string().uuid().nullable().optional(),
  status: z.string().optional(),
  estimated_value: z.coerce.number().optional(),
  probability: z.coerce.number().min(0).max(100).optional(),
  priority: z.coerce.number().optional(),
  custom_data: z.record(z.any()).optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.any()).optional(),
  metadata: z.record(z.any()).optional(),
  profession_id: z.string().uuid().nullable().optional(),
  profession_name: z.string().optional(),
  industry_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  pipeline_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
});

/* =====================
   Helpers
===================== */
function getUserId(req: any) {
  return req?.user?.id ?? null;
}

/* =====================
   Create Lead (+ children)
   POST /api/new/leads
===================== */
leadsNewRouter.post("/new/leads", async (req, res, next) => {
  const who = getUserId(req);
  try {
    const v = LeadCreateSchema.parse(req.body);

    if (v.dry_run) {
      // E.164 preview only
      let e164: string | null = null;
      if (v.primary_phone) {
        const p = parsePhoneNumberFromString(v.primary_phone, "IN");
        if (p?.isValid()) e164 = p.number;
      }
      return res.json({ ok: true, dry_run: true, e164 });
    }

    // compute E.164
    let e164: string|null = null;
    if (v.primary_phone) {
      const p = parsePhoneNumberFromString(v.primary_phone, "IN");
      if (p?.isValid()) e164 = p.number;
    }

    await db.q("BEGIN");
    try {
      const sql = `
        INSERT INTO public.lead
        (tenant_id, company_id, owner_id, pipeline_id, stage_id,
         name, primary_email, primary_phone, primary_phone_e164,
         source_id, status, estimated_value, probability, priority,
         custom_data, tags, meta, metadata,
         profession_id, profession_name, industry_id,
         stage, created_by, created_at, updated_at)
        VALUES
        ($1,$2,$3,$4,$5,
         $6,$7,$8,$9,
         $10,$11,$12,$13,$14,
         $15,$16,$17,$18,
         $19,$20,$21,
         'new',$22, now(), now())
        RETURNING id
      `;
      const params = [
        v.tenant_id, v.company_id ?? null, v.owner_id ?? null, v.pipeline_id ?? null, v.stage_id ?? null,
        v.name, v.primary_email || null, v.primary_phone || null, e164,
        v.source_id ?? null, v.status, v.estimated_value, v.probability, v.priority,
        v.custom_data, v.tags, v.meta, v.metadata,
        v.profession_id ?? null, v.profession_name ?? null, v.industry_id ?? null,
        who
      ];
      const { rows } = await db.query(sql, params);
      const leadId = rows[0].id;

      // followup
      if (v.followup?.enabled && v.followup?.due_at) {
        await db.query(
          `INSERT INTO public.lead_followups
           (tenant_id, company_id, lead_id, due_at, status, note, version, effective_from, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'planned',$5,1, now(), now(), now())`,
          [v.tenant_id, v.company_id ?? null, leadId, v.followup.due_at, v.followup.note ?? null]
        );
      }

      // note
      if (v.note?.enabled && v.note?.body?.trim()) {
        await db.query(
          `INSERT INTO public.lead_note
           (id, lead_id, tenant_id, author_id, body, visibility, metadata, created_at, company_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, COALESCE($5,'internal'), '{}'::jsonb, now(), $6)`,
          [leadId, v.tenant_id, who, v.note.body.trim(), v.note.visibility ?? "internal", v.company_id ?? null]
        );
      }

      // task
      if (v.task?.enabled && v.task?.title?.trim()) {
        await db.query(
          `INSERT INTO public.lead_task
           (id, tenant_id, lead_id, title, due_date, status, assigned_to, created_by, created_at, company_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, COALESCE($5,'open'), $6, $7, now(), $8)`,
          [v.tenant_id, leadId, v.task.title.trim(), v.task.due_date ?? null, v.task.status ?? "open", v.task.assigned_to ?? null, who, v.company_id ?? null]
        );
      }

      await db.q("COMMIT");
      return res.json({ ok: true, id: leadId });
    } catch (e) {
      await db.q("ROLLBACK"); throw e;
    }
  } catch (err) {
    next(err);
  }
});

/* =====================
   GET /api/new/leads/:id
===================== */
leadsNewRouter.get("/new/leads/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const lead = (await db.query(`SELECT * FROM public.lead WHERE id=$1`, [id])).rows[0];
    if (!lead) return res.status(404).json({ error: "lead_not_found" });

    const followups = (await db.query(
      `SELECT * FROM public.lead_followups WHERE lead_id=$1 ORDER BY created_at DESC`, [id]
    )).rows;
    const notes = (await db.query(
      `SELECT * FROM public.lead_note WHERE lead_id=$1 ORDER BY created_at DESC`, [id]
    )).rows;
    const tasks = (await db.query(
      `SELECT * FROM public.lead_task WHERE lead_id=$1 ORDER BY created_at DESC`, [id]
    )).rows;

    return res.json({ ok: true, lead, followups, notes, tasks });
  } catch (err) {
    next(err);
  }
});

/* =====================
   PUT /api/new/leads/:id
===================== */
leadsNewRouter.put("/new/leads/:id", async (req, res, next) => {
  const who = getUserId(req);
  const leadId = req.params.id;

  try {
    const v = LeadUpdateSchema.parse(req.body);
    const oldLeadRes = await db.query(`SELECT * FROM public.lead WHERE id=$1`, [leadId]);
    const oldLead = oldLeadRes.rows[0];
    if (!oldLead) return res.status(404).json({ error: "lead_not_found" });

    await db.q("BEGIN");
    try {
      const sets: string[] = [];
      const params: any[] = [];
      let i = 1;
      for (const [k, val] of Object.entries(v)) {
        if (val === undefined) continue;
        sets.push(`${k}=$${i++}`);
        params.push(val);
      }
      params.push(leadId);

      if (sets.length) {
        await db.query(`UPDATE public.lead SET ${sets.join(", ")}, updated_at=now() WHERE id=$${i}`, params);
      }

      // history logs
      for (const [key, newVal] of Object.entries(v)) {
        if (newVal === undefined) continue;
        const oldVal = oldLead[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          await db.query(
            `INSERT INTO public.lead_history
             (id, lead_id, tenant_id, event_type, field_key, old_value, new_value, meta, created_by, created_at)
             VALUES (gen_random_uuid(), $1, $2, 'field_update', $3, $4, $5, '{}'::jsonb, $6, now())`,
            [leadId, oldLead.tenant_id, key, oldVal, newVal, who]
          );
        }
      }

      // stage history
      if (v.stage_id && v.stage_id !== oldLead.stage_id) {
        await db.query(
          `INSERT INTO public.lead_stage_history
           (id, lead_id, from_stage_id, to_stage_id, changed_by, reason, created_at, tenant_id, from_stage, to_stage)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Stage changed', now(), $5, $6, null)`,
          [leadId, oldLead.stage_id, v.stage_id, who, oldLead.tenant_id, oldLead.stage]
        );
      }

      // owner history
      if (v.owner_id && v.owner_id !== oldLead.owner_id) {
        await db.query(
          `INSERT INTO public.lead_assignment_history
           (id, tenant_id, lead_id, rule_id, from_owner, to_owner, reason, created_by, created_at)
           VALUES (gen_random_uuid(), $1, $2, null, $3, $4, 'Owner changed', $5, now())`,
          [oldLead.tenant_id, leadId, oldLead.owner_id, v.owner_id, who]
        );
      }

      await db.q("COMMIT");
      res.json({ ok: true });
    } catch (e) {
      await db.q("ROLLBACK"); throw e;
    }
  } catch (err) {
    next(err);
  }
});

/* =====================
   LIST + SEARCH
   GET /api/new/leads
===================== */
leadsNewRouter.get("/new/leads", async (req, res, next) => {
  try {
    const { tenant_id, search, pipeline_id, stage_id, owner_id } = req.query as any;
    const filters: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (tenant_id) { filters.push(`tenant_id=$${i++}`); params.push(tenant_id); }
    if (pipeline_id) { filters.push(`pipeline_id=$${i++}`); params.push(pipeline_id); }
    if (stage_id) { filters.push(`stage_id=$${i++}`); params.push(stage_id); }
    if (owner_id) { filters.push(`owner_id=$${i++}`); params.push(owner_id); }

    let sql = `SELECT * FROM public.lead`;
    if (filters.length) sql += ` WHERE ` + filters.join(" AND ");
    if (search) {
      sql += filters.length
        ? ` AND search_vector @@ plainto_tsquery($${i++})`
        : ` WHERE search_vector @@ plainto_tsquery($${i++})`;
      params.push(search);
    }
    sql += ` ORDER BY created_at DESC LIMIT 200`;

    const rows = (await db.query(sql, params)).rows;
    res.json({ ok: true, rows });
  } catch (err) {
    next(err);
  }
});

/* =====================
   DELETE hard
===================== */
leadsNewRouter.delete("/new/leads/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    await db.query(`DELETE FROM public.lead_followups WHERE lead_id=$1`, [id]);
    await db.query(`DELETE FROM public.lead_note WHERE lead_id=$1`, [id]);
    await db.query(`DELETE FROM public.lead_task WHERE lead_id=$1`, [id]);
    await db.query(`DELETE FROM public.lead WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* =====================
   Timeline
===================== */
leadsNewRouter.get("/new/leads/:id/timeline", async (req, res, next) => {
  try {
    const id = req.params.id;
    const sql = `
      SELECT 'history' AS type, created_at, field_key, old_value, new_value, created_by
      FROM public.lead_history WHERE lead_id=$1
      UNION ALL
      SELECT 'stage_history' AS type, created_at, from_stage AS old_value, to_stage AS new_value, changed_by AS created_by
      FROM public.lead_stage_history WHERE lead_id=$1
      UNION ALL
      SELECT 'followup' AS type, created_at, status AS old_value, note AS new_value, created_by
      FROM public.lead_followups WHERE lead_id=$1
      UNION ALL
      SELECT 'note' AS type, created_at, visibility AS old_value, body AS new_value, author_id AS created_by
      FROM public.lead_note WHERE lead_id=$1
      UNION ALL
      SELECT 'activity' AS type, created_at, action_key AS old_value, payload::text AS new_value, actor_id AS created_by
      FROM public.lead_activity WHERE lead_id=$1
      UNION ALL
      SELECT 'task' AS type, created_at, status AS old_value, title AS new_value, created_by
      FROM public.lead_task WHERE lead_id=$1
      ORDER BY created_at DESC
      LIMIT 200`;
    const rows = (await db.query(sql, [id])).rows;
    res.json({ ok: true, rows });
  } catch (err) {
    next(err);
  }
});

/* =====================
   Move (Kanban)
===================== */
leadsNewRouter.post("/new/leads/:id/move", async (req, res, next) => {
  const leadId = req.params.id;
  const { to_stage_id, tenant_id } = req.body;
  const who = getUserId(req);
  try {
    const old = (await db.query(
      `SELECT stage_id, stage, pipeline_id FROM public.lead WHERE id=$1`, [leadId]
    )).rows[0];
    if (!old) return res.status(404).json({ error: "lead_not_found" });

    await db.q("BEGIN");
    await db.query(`UPDATE public.lead SET stage_id=$1, updated_at=now() WHERE id=$2`, [to_stage_id, leadId]);
    await db.query(
      `INSERT INTO public.lead_stage_history
       (id, lead_id, from_stage_id, to_stage_id, changed_by, reason, created_at, tenant_id, from_stage, to_stage)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Kanban Move', now(), $5, $6, null)`,
      [leadId, old.stage_id, to_stage_id, who, tenant_id, old.stage]
    );
    await db.q("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await db.q("ROLLBACK"); next(err);
  }
});

/* =====================
   Merge
===================== */
leadsNewRouter.post("/new/leads/merge", async (req, res, next) => {
  try {
    const { source_id, target_id, tenant_id } = req.body;
    if (!source_id || !target_id) return res.status(400).json({ error: "invalid_ids" });

    await db.q("BEGIN");
    const tables = ["lead_followups","lead_note","lead_task","lead_activity","lead_event"];
    for (const t of tables) {
      await db.query(`UPDATE public.${t} SET lead_id=$1 WHERE lead_id=$2`, [target_id, source_id]);
    }
    await db.query(`DELETE FROM public.lead WHERE id=$1`, [source_id]);
    await db.query(
      `INSERT INTO public.lead_event (id, tenant_id, lead_id, event_key, payload, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'merge', jsonb_build_object('from',$3,'to',$2), now())`,
      [tenant_id, target_id, source_id]
    );
    await db.q("COMMIT");
    res.json({ ok: true });
  } catch (err) { await db.q("ROLLBACK"); next(err); }
});
