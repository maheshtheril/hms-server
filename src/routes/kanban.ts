// server/src/routes/kanban.ts
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/* ───────── Types ───────── */
type SessionReq = Request & {
  session?: { tenant_id?: string };
};

function ensureTenant(req: SessionReq) {
  const s = req.session;
  if (!s?.tenant_id) throw new Error("tenant_missing");
  return s.tenant_id as string;
}

type PipelineRow = { id: string; name: string };
type StageRow = {
  id: string;
  key: string | null;
  name: string;
  sort_order: number | null;
  is_won: boolean | null;
  is_lost: boolean | null;
};
type LeadRow = {
  id: string;
  name: string;
  stage_id: string | null;
  estimated_value: number | null;
  owner_id: string | null;
  updated_at: string | Date | null;
  position: number | null;
  owner_name: string | null;
  owner_email: string | null;
  probability: number | null;
};

type KanbanColumn = StageRow & { leads: LeadRow[] };

type ReorderBody = {
  stage_id: string;
  ordered_ids: string[];
};

/* ───────── Handlers ───────── */

/** GET /api/pipelines — list pipelines for current tenant */
const listPipelines: RequestHandler = async (req: SessionReq, res: Response) => {
  const tenantId = ensureTenant(req);

  const { rows } = await q<PipelineRow>(
    `SELECT id, name
       FROM public.pipeline
      WHERE tenant_id = $1
      ORDER BY created_at ASC`,
    [tenantId]
  );

  res.json(rows);
};

/** GET /api/pipelines/:id/stages — list stages for a given pipeline */
const listStages: RequestHandler = async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows } = await q<StageRow>(
    `SELECT id, key, name, sort_order, is_won, is_lost
       FROM public.pipeline_stage
      WHERE pipeline_id = $1
      ORDER BY sort_order ASC, created_at ASC`,
    [id]
  );

  res.json(rows);
};

/** GET /api/kanban/:pipelineId — columns + leads */
const getKanban: RequestHandler = async (req: SessionReq, res: Response) => {
  const tenantId = ensureTenant(req);
  const { pipelineId } = req.params;

  const stagesRes = await q<StageRow>(
    `SELECT ps.id, ps.name, ps.key, ps.sort_order, ps.is_won, ps.is_lost
       FROM public.pipeline_stage ps
      WHERE ps.pipeline_id = $1
      ORDER BY ps.sort_order ASC, ps.created_at ASC`,
    [pipelineId]
  );

  const leadsRes = await q<LeadRow>(
    `SELECT l.id, l.name, l.stage_id, l.estimated_value,
            l.owner_id, l.updated_at, l.position,
            au.name AS owner_name, au.email AS owner_email,
            l.probability
       FROM public.lead l
  LEFT JOIN public.app_user au ON au.id = l.owner_id
      WHERE l.tenant_id = $1 AND l.pipeline_id = $2
      ORDER BY COALESCE(l.position, 0) ASC, l.updated_at DESC`,
    [tenantId, pipelineId]
  );

  const cols: KanbanColumn[] = stagesRes.rows.map((s) => ({ ...s, leads: [] }));
  const map = new Map<string, KanbanColumn>(cols.map((c) => [String(c.id), c]));

  for (const L of leadsRes.rows) {
    const col = map.get(String(L.stage_id));
    if (col) col.leads.push(L);
  }

  res.json({ columns: cols });
};

/** POST /api/kanban/reorder — persist ordering within a stage */
const postReorder: RequestHandler = async (req: SessionReq, res: Response) => {
  const tenantId = ensureTenant(req);
  const { stage_id, ordered_ids } = (req.body ?? {}) as Partial<ReorderBody>;

  if (!stage_id || !Array.isArray(ordered_ids)) {
    return res.status(400).json({ error: "bad_request" });
  }

  await Promise.all(
    ordered_ids.map((id, idx) =>
      q(
        `UPDATE public.lead
            SET position = $1
          WHERE id = $2
            AND stage_id = $3
            AND tenant_id = $4`,
        [idx, id, stage_id, tenantId]
      )
    )
  );

  res.json({ ok: true });
};

/* ───────── Routes ───────── */
router.get("/pipelines", requireAuth, listPipelines);
router.get("/pipelines/:id/stages", requireAuth, listStages);
router.get("/kanban/:pipelineId", requireAuth, getKanban);
router.post("/kanban/reorder", requireAuth, postReorder);

export default router;
