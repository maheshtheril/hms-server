// server/src/routes/leads.ts
import { Router } from "express";
import { q } from "../db"; // your q helper that returns { rows }
import requireSession from "../middleware/requireSession";
import { v4 as uuidv4 } from "uuid";

const router = Router();

// Create lead
router.post("/", requireSession, async (req, res) => {
  try {
    const user = (req as any).session;
    const tenant_id = user.tenant_id;
    const company_id = user.active_company_id || null;
    const created_by = user.user_id;

    const {
      name,
      primary_email,
      primary_phone,
      pipeline_id = null,
      stage_id = null,
      owner_id = null,
      estimated_value = 0,
      probability = 0,
      priority = 3,
      custom_data = {},
      tags = [],
      meta = {},
    } = req.body || {};

    if (!name) return res.status(400).json({ error: "missing_name" });

    const id = uuidv4();
    // Insert lead
    await q(
      `INSERT INTO public.lead
         (id, tenant_id, company_id, owner_id, pipeline_id, stage_id, name, primary_email, primary_phone,
          estimated_value, probability, priority, custom_data, tags, meta, created_by, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now())`,
      [
        id,
        tenant_id,
        company_id,
        owner_id,
        pipeline_id,
        stage_id,
        name,
        primary_email,
        primary_phone,
        estimated_value,
        probability,
        priority,
        JSON.stringify(custom_data),
        tags || [],
        JSON.stringify(meta),
        created_by,
      ]
    );

    // record activity (optional)
    await q(
      `INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at, company_id)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now(), $6::uuid)`,
      [id, tenant_id, created_by, "lead.created", JSON.stringify({ name }), company_id]
    );

    const { rows } = await q(`SELECT * FROM public.lead WHERE id = $1 LIMIT 1`, [id]);
    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("POST /api/leads error:", err);
    return res.status(500).json({ error: "create_lead_failed" });
  }
});

// Get list of leads
router.get("/", requireSession, async (req, res) => {
  try {
    const user = (req as any).session;
    const tenant_id = user.tenant_id;
    // basic listing; you likely want pagination, filters, tenancy enforcement
    const { rows } = await q(`SELECT * FROM public.lead WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`, [tenant_id]);
    res.json({ data: rows });
  } catch (err) {
    console.error("GET /api/leads error:", err);
    return res.status(500).json({ error: "list_leads_failed" });
  }
});

// Get single lead
router.get("/:id", requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    const { rows } = await q(`SELECT * FROM public.lead WHERE id = $1 LIMIT 1`, [id]);
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error("GET /api/leads/:id error:", err);
    return res.status(500).json({ error: "get_lead_failed" });
  }
});

// Update lead (partial)
router.patch("/:id", requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    const user = (req as any).session;
    const allowed = ["name", "primary_email", "primary_phone", "owner_id", "stage_id", "pipeline_id", "status", "estimated_value", "probability", "priority", "custom_data", "tags", "meta"];
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const k of allowed) {
      if (k in req.body) {
        updates.push(`${k} = $${idx}::${k === "tags" ? "text[]" : (k === "custom_data" || k === "meta" ? "jsonb" : "text")}`);
        let v = req.body[k];
        if (k === "custom_data" || k === "meta") v = JSON.stringify(v || {});
        values.push(v);
        idx++;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: "nothing_to_update" });
    values.push(id);
    const sql = `UPDATE public.lead SET ${updates.join(", ")}, updated_at = now() WHERE id = $${idx} RETURNING *`;
    const { rows } = await q(sql, values);
    // activity
    await q(`INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now())`, [id, user.tenant_id, user.user_id, "lead.updated", JSON.stringify(req.body)]);
    res.json({ data: rows[0] });
  } catch (err) {
    console.error("PATCH /api/leads/:id error:", err);
    return res.status(500).json({ error: "update_lead_failed" });
  }
});

// Delete lead (soft delete pattern could be preferred)
router.delete("/:id", requireSession, async (req, res) => {
  try {
    const id = req.params.id;
    await q(`DELETE FROM public.lead WHERE id = $1`, [id]);
    await q(`INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb, now())`, [id, (req as any).session.tenant_id, (req as any).session.user_id, "lead.deleted"]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/leads/:id error:", err);
    return res.status(500).json({ error: "delete_lead_failed" });
  }
});
router.post("/notes", requireSession, async (req, res) => {
  try {
    const { lead_id, body, visibility = "internal" } = req.body;
    if (!lead_id || !body) return res.status(400).json({ error: "missing_fields" });
    const id = uuidv4();
    const user = (req as any).session;
    await q(`INSERT INTO public.lead_note (id, lead_id, tenant_id, author_id, body, visibility, metadata, created_at, company_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,now(),$8::uuid)`, [id, lead_id, user.tenant_id, user.user_id, body, visibility, JSON.stringify({}), user.active_company_id]);
    const { rows } = await q(`SELECT * FROM public.lead_note WHERE id = $1`, [id]);
    await q(`INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now())`, [lead_id, user.tenant_id, user.user_id, "lead.note.created", JSON.stringify({ note_id: id })]);
    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("POST /api/lead-notes", err);
    return res.status(500).json({ error: "create_note_failed" });
  }
});
router.post("/tasks", requireSession, async (req, res) => {
  try {
    const { lead_id, title, due_date, assigned_to = null } = req.body;
    if (!lead_id || !title) return res.status(400).json({ error: "missing_fields" });
    const id = uuidv4();
    const user = (req as any).session;
    await q(`INSERT INTO public.lead_task (id, tenant_id, lead_id, title, due_date, status, assigned_to, created_by, created_at, company_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::uuid,now(),$9::uuid)`, [id, user.tenant_id, lead_id, title, due_date || null, "open", assigned_to, user.user_id, user.active_company_id]);
    const { rows } = await q(`SELECT * FROM public.lead_task WHERE id = $1`, [id]);
    await q(`INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now())`, [lead_id, user.tenant_id, user.user_id, "lead.task.created", JSON.stringify({ task_id: id })]);
    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("POST /api/lead-tasks", err);
    return res.status(500).json({ error: "create_task_failed" });
  }
});
router.post("/followups", requireSession, async (req, res) => {
  try {
    const { lead_id, due_at, note = null } = req.body;
    if (!lead_id || !due_at) return res.status(400).json({ error: "missing_fields" });
    const user = (req as any).session;
    const { rows } = await q(`INSERT INTO public.lead_followups (tenant_id, company_id, lead_id, due_at, status, note, created_by, changed_by, version, effective_from, created_at, updated_at, due_date_local)
                              VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::uuid,$9,now(),now(),now(), $10::date) RETURNING *`,
      [user.tenant_id, user.active_company_id, lead_id, due_at, 'planned', note, user.user_id, user.user_id, 1, (new Date(due_at)).toISOString().slice(0,10)]);
    await q(`INSERT INTO public.lead_activity (id, lead_id, tenant_id, actor_id, action_key, payload, created_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now())`, [lead_id, user.tenant_id, user.user_id, "lead.followup.created", JSON.stringify({ followup_id: rows[0].id })]);
    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("POST /api/lead-followups", err);
    return res.status(500).json({ error: "create_followup_failed" });
  }
});

export default router;
