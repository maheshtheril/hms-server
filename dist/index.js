"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// server/src/index.ts
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const path_1 = __importDefault(require("path"));
/* ───────────────────────────── Routers ───────────────────────────── */
const custom_fields_1 = __importDefault(require("./routes/admin/custom-fields"));
const custom_fields_2 = __importDefault(require("./routes/leads/custom-fields"));
const auth_1 = __importDefault(require("./routes/auth"));
const me_1 = __importDefault(require("./routes/me"));
const kpis_1 = __importDefault(require("./routes/kpis"));
const leads_1 = __importDefault(require("./routes/leads"));
const pipelines_1 = __importDefault(require("./routes/pipelines"));
const kanban_1 = __importDefault(require("./routes/kanban"));
const admin_1 = __importDefault(require("./routes/admin"));
const tenants_1 = __importDefault(require("./routes/tenants"));
const users_1 = __importDefault(require("./routes/admin/users"));
const roles_1 = __importDefault(require("./routes/admin/roles"));
const permissions_1 = __importDefault(require("./routes/admin/permissions"));
const audit_logs_1 = __importDefault(require("./routes/audit-logs"));
const scheduler_1 = __importDefault(require("./routes/scheduler"));
const companies_1 = __importDefault(require("./routes/admin/companies"));
const tenant_signup_1 = __importDefault(require("./routes/tenant-signup")); // ✅ kebab-case file
const uploads_1 = __importDefault(require("./routes/uploads"));
/* ───────────────────────────── Express init ───────────────────────────── */
const app = (0, express_1.default)();
app.set("trust proxy", 1); // required for secure cookies on Render
/* ───────────────────────────── CORS ───────────────────────────── */
// APP_ORIGIN may be comma-separated: "https://site1.com,http://localhost:3000"
const rawOrigins = (process.env.APP_ORIGIN || "http://localhost:3000").split(",");
const ALLOWED_ORIGINS = rawOrigins.map((s) => s.trim()).filter(Boolean);
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        // Allow server-to-server/SSR (no Origin) and approved origins
        if (!origin)
            return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin))
            return cb(null, true);
        // Don’t throw; fail with not allowed
        return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "X-Requested-With", "Authorization"],
}));
// Preflight fast-path
app.options("*", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With, Authorization");
    return res.sendStatus(200);
});
app.use(express_1.default.json({ limit: "10mb" }));
app.use((0, cookie_parser_1.default)());
/* ───────────────────────────── Health ───────────────────────────── */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));
/* ───────────────────────────── Static uploads ───────────────────────────── */
app.use("/uploads", express_1.default.static(path_1.default.join(process.cwd(), "uploads"), { maxAge: "1h", index: false }));
/* ───────────────────────────── Auth + Core APIs ───────────────────────────── */
app.use("/auth", auth_1.default); // note: NOT under /api
app.use("/api", me_1.default);
app.use("/api", kpis_1.default);
app.use("/api", leads_1.default);
app.use("/api", pipelines_1.default);
app.use("/api", kanban_1.default);
/* ───────────────────────────── Admin namespace ───────────────────────────── */
app.use("/api/admin", admin_1.default);
app.use("/api/admin/users", users_1.default);
app.use("/api/admin/roles", roles_1.default);
app.use("/api/admin/permissions", permissions_1.default);
app.use("/api/admin/companies", companies_1.default);
app.use("/api/admin/custom-fields", custom_fields_1.default);
/* ───────────────────────────── Uploads, Tenants, Scheduler ───────────────────────────── */
app.use("/api/uploads", uploads_1.default);
app.use("/api/tenants", tenants_1.default);
app.use("/api/tenant-signup", tenant_signup_1.default); // POST /
app.use("/api/audit-logs", audit_logs_1.default);
app.use("/api/scheduler", scheduler_1.default);
/* ───────────────────────────── Leads custom fields ───────────────────────────── */
app.use("/api/leads", custom_fields_2.default);
/* ───────────────────────────── Internal healthcheck ───────────────────────────── */
app.get("/api/admin/__health", (_req, res) => res.json({ ok: true, where: "index mount layer" }));
/* ───────────────────────────── 404 handler ───────────────────────────── */
app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
});
/* ───────────────────────────── Global error handler ───────────────────────────── */
app.use((err, _req, res, _next) => {
    console.error("[ERROR]", err);
    const body = {
        error: err?.code || "internal_server_error",
        message: err?.message || "Unexpected error",
    };
    if (process.env.NODE_ENV !== "production" && err?.stack) {
        body.stack = String(err.stack).split("\n");
    }
    if (err?.detail)
        body.detail = err.detail;
    if (err?.hint)
        body.hint = err.hint;
    if (err?.constraint)
        body.constraint = err.constraint;
    const status = err?.statusCode || err?.status || 500;
    res.status(status).json(body);
});
/* ───────────────────────────── Start server ───────────────────────────── */
const PORT = Number(process.env.PORT || 4000); // Render injects a dynamic PORT (e.g., 10000)
app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 Server running from", process.cwd());
    console.log(`✅ Listening on port ${PORT}`);
    console.log(`NODE_ENV=${process.env.NODE_ENV}`);
    console.log(`APP_ORIGIN=${ALLOWED_ORIGINS.join(",")}`);
});
