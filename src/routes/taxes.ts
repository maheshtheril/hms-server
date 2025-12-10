// server/src/routes/taxes.ts
import { Router } from "express";
import db from "../db";

const router = Router();

router.get("/taxes", async (req, res) => {
  const { company_id } = req.query;

  const rows = await db.any(
    `SELECT id, name, rate, account_id
     FROM company_taxes
     WHERE company_id = $1
     ORDER BY name ASC`,
    [company_id]
  );

  res.json(rows);
});

export default router;
