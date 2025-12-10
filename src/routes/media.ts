// server/src/routes/media.ts
import { Router } from "express";
import db from "../db";
import { v4 as uuid } from "uuid";
import multer from "multer";

const upload = multer({ dest: "uploads/" });
const router = Router();

router.post("/media/upload", upload.single("file"), async (req, res) => {
  const id = uuid();

  await db.none(
    `INSERT INTO hms_product_media (id, url, file_name, mime_type)
     VALUES ($1,$2,$3,$4)`,
    [
      id,
      `/uploads/${req.file.filename}`,
      req.file.originalname,
      req.file.mimetype,
    ]
  );

  res.json({
    id,
    url: `/uploads/${req.file.filename}`,
  });
});

router.delete("/media/:id", async (req, res) => {
  await db.none(`DELETE FROM hms_product_media WHERE id = $1`, [
    req.params.id,
  ]);

  res.json({ ok: true });
});

export default router;
