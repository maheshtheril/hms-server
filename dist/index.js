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
const check_email_1 = __importDefault(require("./routes/check-email"));
const kpis_todays_1 = __importDefault(require("./routes/kpis_todays"));
const kpis_1 = __importDefault(require("./routes/kpis"));
const hmsDepartments_1 = __importDefault(require("./routes/hmsDepartments"));
const hmsSettings_1 = __importDefault(require("./routes/hmsSettings"));
const hmsPatients_1 = __importDefault(require("./routes/hmsPatients"));
const hmsPatientInsights_1 = __importDefault(require("./routes/hmsPatientInsights"));
const hmsClinicians_1 = __importDefault(require("./routes/hmsClinicians"));
const hmsClinicians_2 = __importDefault(require("./routes/hmsClinicians"));
const hmsAppointments_1 = __importDefault(require("./routes/hmsAppointments"));
const hmsStock_1 = __importDefault(require("./routes/hmsStock"));
const hmsPurchases_1 = __importDefault(require("./routes/hmsPurchases"));
const hmsReceipts_1 = __importDefault(require("./routes/hmsReceipts"));
const hmsInvoices_1 = __importDefault(require("./routes/hmsInvoices"));
/* ───────────────────────────── Express init ───────────────────────────── */
const app = (0, express_1.default)();
app.set("trust proxy", 1); // required for secure cookies on Render
/* ───────────────────────────── CORS ───────────────────────────── */
// APP_ORIGIN may be comma-separated: "https://site1.com,http://localhost:3000"
const rawOrigins = (process.env.APP_ORIGIN || "http://localhost:3000").split(",");
const ALLOWED_ORIGINS = rawOrigins.map((s) => s.trim()).filter(Boolean);
// === Debug routes (for Render diagnostics) ===
app.get("/api/_debug", (_req, res) => {
    res.json({
        ok: true,
        env: process.env.NODE_ENV || "development",
        timestamp: new Date().toISOString(),
    });
});
app.get("/api/_routes", (_req, res) => {
    try {
        let listEndpoints = null;
        try {
            listEndpoints = require("express-list-endpoints");
        }
        catch {
            listEndpoints = null;
        }
        if (listEndpoints) {
            const endpoints = listEndpoints(app);
            return res.json({ ok: true, endpoints });
        }
        const routes = [];
        function walk(stack) {
            for (const layer of stack) {
                if (layer.route && layer.route.path) {
                    const methods = Object.keys(layer.route.methods || {})
                        .map((m) => m.toUpperCase())
                        .join(",");
                    routes.push({ method: methods || "ALL", path: layer.route.path });
                }
                else if (layer.name === "router" && layer.handle && layer.handle.stack) {
                    walk(layer.handle.stack);
                }
            }
        }
        if (app._router && app._router.stack)
            walk(app._router.stack);
        return res.json({ ok: true, endpoints: routes });
    }
    catch (err) {
        return res.status(500).json({ ok: false, error: "failed_to_list_routes", message: String(err) });
    }
});
// === end debug routes ===
app.use((0, cors_1.default)({
    origin: (origin, cb) => {
        // Allow server-to-server/SSR (no Origin) and approved origins
        if (!origin)
            return cb(null, true);
        if (ALLOWED_ORIGINS.includes(origin))
            return cb(null, true);
        // Soft-fail CORS (no error thrown), request just won't get CORS headers
        return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "X-Requested-With", "Authorization"],
}));
// Preflight fast-path (helpful when backend is called directly)
app.options("*", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-Requested-With, Authorization");
    return res.sendStatus(200);
});
app.use("/api/kpis", kpis_1.default);
/* ───────────────────────────── Parsers BEFORE routes ───────────────────────────── */
app.use((0, cookie_parser_1.default)());
app.use(express_1.default.json({ limit: "10mb" }));
app.use(express_1.default.urlencoded({ extended: true, limit: "10mb" }));
/* ───────────────────────────── Request logger ───────────────────────────── */
app.use((req, _res, next) => {
    console.log(`[IN] ${req.method} ${req.path}`);
    next();
});
/* ───────────────────────────── Health ───────────────────────────── */
app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));
/* ───────────────────────────── Static uploads ───────────────────────────── */
app.use("/uploads", express_1.default.static(path_1.default.join(process.cwd(), "uploads"), { maxAge: "1h", index: false }));
/* ───────────────────────────── PROBE endpoint ─────────────────────────────
   Use this to confirm rewrites/proxy/body parsing end-to-end.
   POST /api/leads/__probe → 200 with echoed body.
-------------------------------------------------------------------------- */
app.post("/api/leads/__probe", (req, res) => {
    res.status(200).json({ ok: true, where: "probe", body: req.body ?? null });
});
/* ───────────────────────────── Auth + Core APIs ───────────────────────────── */
// Note: auth is NOT under /api by design (web rewrite maps /api/auth → /auth)
app.use("/auth", auth_1.default);
app.use("/api/check-email", check_email_1.default);
app.use("/api", kpis_todays_1.default);
app.use("/api/hms/departments", hmsDepartments_1.default);
app.use("/api", me_1.default);
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
app.use("/api/hms/settings", hmsSettings_1.default);
app.use("/api/hms/patients", hmsPatients_1.default);
app.use("/api/hms", hmsPatientInsights_1.default);
app.use("/api/hms/clinicians", hmsClinicians_1.default);
app.use("/api/hms/clinicians", hmsClinicians_2.default);
app.use("/hms/appointments", hmsAppointments_1.default);
app.use("/hms/stock", hmsStock_1.default);
app.use("/hms/purchases", hmsPurchases_1.default);
app.use("/hms/receipts", hmsReceipts_1.default);
app.use("/hms/invoices", hmsInvoices_1.default);
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
/* ────────────────────────────────────────────────────────────────────────────
   Compatibility shims (non-invasive redirects)
   These preserve your existing handlers and simply redirect legacy
   frontend requests to the mounted /api endpoints.
   - /kpis           -> /api/kpis
   - /kpis/todays    -> /api/kpis/todays
   These are safe, temporary, and can be removed once frontend is fixed.
──────────────────────────────────────────────────────────────────────────── */
app.get("/kpis", (req, res) => {
    const qs = req.url.split("?")[1] || "";
    const target = "/api/kpis" + (qs ? `?${qs}` : "");
    res.redirect(307, target);
});
app.get("/kpis/todays", (req, res) => {
    const qs = req.url.split("?")[1] || "";
    const target = "/api/kpis/todays" + (qs ? `?${qs}` : "");
    res.redirect(307, target);
});
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
