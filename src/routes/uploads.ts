// server/src/routes/uploads.ts
import { Router } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";

const router = Router();

// ensure local uploads dir exists: <repo>/server/uploads
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${ts}__${safe}`);
  },
});
const upload = multer({ storage });

// quick health
router.get("/health", (_req, res) => {
  res.json({ ok: true, route: "/api/uploads", dir: "/uploads" });
});

// POST /api/uploads  (multipart field name: "file")
router.post("/", upload.single("file"), (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const url = `/uploads/${req.file.filename}`;
  res.json({
    url,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    originalName: req.file.originalname,
  });
});

export default router;
