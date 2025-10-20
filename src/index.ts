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
import tenantSignup from "./routes/tenant-signup"; // ✅ kebab-case file
import uploadsRouter from "./routes/uploads";
import checkEmail from "./routes/check-email";
import kpisTodaysRouter from "./routes/kpis_todays";
import kpisRouter from "./routes/kpis";


/* ───────────────────────────── Express init ───────────────────────────── */
const app = express();
app.set("trust proxy", 1); // required for secure cookies on Render

/* ───────────────────────────── CORS ───────────────────────────── */
// APP_ORIGIN may be comma-separated: "https://site1.com,http://localhost:3000"
const rawOrigins = (process.env.APP_ORIGIN || "http://localhost:3000").split(",");
const ALLOWED_ORIGINS = rawOrigins.map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow server-to-server/SSR (no Origin) and approved origins
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      // Soft-fail CORS (no error thrown), request just won't get CORS headers
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "X-Requested-With", "Authorization"],
  })
);

// Preflight fast-path (helpful when backend is called directly)
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Requested-With, Authorization"
  );
  return res.sendStatus(200);
});
app.use("/api/kpis", kpisRouter); 


/* ───────────────────────────── Parsers BEFORE routes ───────────────────────────── */
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ───────────────────────────── Request logger ───────────────────────────── */
app.use((req, _res, next) => {
  console.log(`[IN] ${req.method} ${req.path}`);
  next();
});

/* ───────────────────────────── Health ───────────────────────────── */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

/* ───────────────────────────── Static uploads ───────────────────────────── */
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"), { maxAge: "1h", index: false })
);

/* ───────────────────────────── PROBE endpoint ─────────────────────────────
   Use this to confirm rewrites/proxy/body parsing end-to-end.
   POST /api/leads/__probe → 200 with echoed body.
-------------------------------------------------------------------------- */
app.post("/api/leads/__probe", (req, res) => {
  res.status(200).json({ ok: true, where: "probe", body: req.body ?? null });
});

/* ───────────────────────────── Auth + Core APIs ───────────────────────────── */
// Note: auth is NOT under /api by design (web rewrite maps /api/auth → /auth)
app.use("/auth", auth);
app.use("/api/check-email", checkEmail);

app.use("/", kpisTodaysRouter);


app.use("/api", me);

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
app.use("/api/tenant-signup", tenantSignup); // POST /
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
const PORT = Number(process.env.PORT || 4000); // Render injects a dynamic PORT (e.g., 10000)
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running from", process.cwd());
  console.log(`✅ Listening on port ${PORT}`);
  console.log(`NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`APP_ORIGIN=${ALLOWED_ORIGINS.join(",")}`);
});
