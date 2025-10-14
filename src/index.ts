// server/src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";

/* ───────────────────────────── Routers ───────────────────────────── */
import adminCustomFieldsRouter from "./routes/admin/custom-fields";
import leadCustomFieldsRouter from "./routes/leads/custom-fields";
import auth from "./routes/auth";
import me from "./routes/me";
import kpis from "./routes/kpis";
import leads from "./routes/leads";
import pipelines from "./routes/pipelines";
import kanban from "./routes/kanban";
import adminRoutes from "./routes/admin";
import tenantsRouter from "./routes/tenants";
import adminUsers from "./routes/admin/users";
import adminRolesRouter from "./routes/admin/roles";
import adminPermissionsRouter from "./routes/admin/permissions";
import auditLogs from "./routes/audit-logs";
import schedulerRouter from "./routes/scheduler";
import adminCompaniesRouter from "./routes/admin/companies";
import tenantSignup from "./routes/tenant-signup";   // ✅ kebab-case, matches file on Render
import uploadsRouter from "./routes/uploads";

/* ───────────────────────────── Express init ───────────────────────────── */
const app = express();
app.set("trust proxy", 1); // required for secure cookies on Render

/* ───────────────────────────── CORS ───────────────────────────── */
// APP_ORIGIN may be comma-separated: "https://site1.com,http://localhost:3000"
const rawOrigins = (process.env.APP_ORIGIN || "http://localhost:3000").split(",");
const ORIGINS = rawOrigins.map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow SSR/no-origin and known origins
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed: " + origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "X-Requested-With", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

/* ───────────────────────────── Health ───────────────────────────── */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

/* ───────────────────────────── Static uploads ───────────────────────────── */
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"), { maxAge: "1h", index: false })
);

/* ───────────────────────────── Auth + Core APIs ───────────────────────────── */
app.use("/auth", auth); // note: not under /api
app.use("/api", me);
app.use("/api", kpis);
app.use("/api", leads);
app.use("/api", pipelines);
app.use("/api", kanban);

/* ───────────────────────────── Admin namespace ───────────────────────────── */
app.use("/api/admin", adminRoutes);
app.use("/api/admin/users", adminUsers);
app.use("/api/admin/roles", adminRolesRouter);
app.use("/api/admin/permissions", adminPermissionsRouter);
app.use("/api/admin/companies", adminCompaniesRouter);
app.use("/api/admin/custom-fields", adminCustomFieldsRouter);

/* ───────────────────────────── Uploads, Tenants, Scheduler ───────────────────────────── */
app.use("/api/uploads", uploadsRouter);
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenant-signup", tenantSignup); // POST / → tenant signup
app.use("/api/audit-logs", auditLogs);
app.use("/api/scheduler", schedulerRouter);

/* ───────────────────────────── Leads custom fields ───────────────────────────── */
app.use("/api/leads", leadCustomFieldsRouter);

/* ───────────────────────────── Internal healthcheck ───────────────────────────── */
app.get("/api/admin/__health", (_req, res) =>
  res.json({ ok: true, where: "index mount layer" })
);

/* ───────────────────────────── 404 handler ───────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

/* ───────────────────────────── Global error handler ───────────────────────────── */
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[ERROR]", err);

    const body: any = {
      error: err?.code || "internal_server_error",
      message: err?.message || "Unexpected error",
    };

    if (process.env.NODE_ENV !== "production" && err?.stack) {
      body.stack = String(err.stack).split("\n");
    }
    if (err?.detail) body.detail = err.detail;
    if (err?.hint) body.hint = err.hint;
    if (err?.constraint) body.constraint = err.constraint;

    const status = err?.statusCode || err?.status || 500;
    res.status(status).json(body);
  }
);

/* ───────────────────────────── Start server ───────────────────────────── */
const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running from", process.cwd());
  console.log(`✅ Listening on port ${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`APP_ORIGIN=${ORIGINS.join(",")}`);
});
