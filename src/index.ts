// server/src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { sessionLoader } from "./middleware/sessionLoader";
import sessionRouter from "./routes/session";
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
import hmsDepartments from "./routes/hmsDepartments";
import hmsSettingsRouter from "./routes/hmsSettings";
import hmsPatientsRouter from "./routes/hmsPatients";
import hmsPatientInsights from "./routes/hmsPatientInsights";
import hmsClinicians from "./routes/hmsClinicians";
import hmsCliniciansRouter from "./routes/hmsClinicians";
import hmsAppointments from "./routes/hmsAppointments";
import stockRouter from "./routes/hmsStock";
import hmsPurchasesRouter from "./routes/hmsPurchases";
import hmsReceiptsRouter from "./routes/hmsReceipts";
import hmsInvoicesRouter from "./routes/hmsInvoices";
import rolesRouter from "./routes/hmsRoles";
import specsRouter from "./routes/hmsSpecializations";
import leadSourcesRouter from "./routes/leads/sources";
import leadProfessionsRouter from "./routes/leads/professions";
import leadPipelinesRouter from "./routes/leads/pipelines";
import leadStagesRouter from "./routes/leads/stages";
import leadIndustriesRouter from "./routes/leads/industries";
import { leadsNewRouter } from "./routes/new/leads-new";


/* ---- NEW imports added ---- */

import companiesRouter from "./routes/hms/companies";
import productsRouter from "./routes/hms/products";
import settingsRouter from "./routes/settings";
import globalCurrenciesRouter from "./routes/global/currencies";
import globalTaxTypesRouter from "./routes/global/tax-types";
import globalTaxRatesRouter from "./routes/global/tax-rates";
// add with other global imports
import globalCountriesRouter from "./routes/global/countries";
import globalCompanySettingsRouter from "./routes/global/company-settings";
import globalCompanyTaxesRouter from "./routes/global/company-taxes";
import { requireTenant } from "./middleware/tenant"; 
import accountingRoutes from "./routes/accounting.routes";
import signupRouter from "./routes/api/auth/signup";
import loginRoute from "./routes/api/auth/login";
import coreRouter from "./routes/core";
import userCompaniesRouter from "./routes/api/user/companies";
import invoiceRoutes from "./routes/invoiceRoutes";
import hmsOnboardingRouter from "./routes/api/onboarding/hms";

// new HMS API routers (generated)
import labOrdersRouter from "./routes/hms/lab/lab.orders";
import labSamplesRouter from "./routes/hms/lab/lab.samples";
import labResultsRouter from "./routes/hms/lab/lab.results";
import labWorklistRouter from "./routes/hms/lab/lab.worklist";

import imagingOrdersRouter from "./routes/hms/imaging/imaging.orders";
import imagingStudiesRouter from "./routes/hms/imaging/imaging.studies"; // if created
import imagingRouter from "./routes/hms/imaging"; // optional aggregate

import encountersRouter from "./routes/hms/clinical/encounters";
import vitalsRouter from "./routes/hms/clinical/vitals";
import triageRouter from "./routes/hms/clinical/triage";
import notesRouter from "./routes/hms/clinical/notes";
import diagnosisRouter from "./routes/hms/clinical/diagnosis";
import proceduresRouter from "./routes/hms/procedures";

import medOrdersRouter from "./routes/hms/pharmacy/medication.orders";
import medAdminRouter from "./routes/hms/pharmacy/medication.admin";

import billingRulesRouter from "./routes/hms/billing/billing.rules";

import aiTasksRouter from "./routes/hms/ai/ai.tasks";
import tenantDashboardRouter from "./routes/tenant/dashboard";
import companyDashboardRouter from "./routes/company/dashboard";
import pharmacyBillingRouter from "./routes/hms/pharmacy/pharmacy.billing";

/* -------------------------- */


/* ───────────────────────────── Express init ───────────────────────────── */
const app = express();
/* ───────────────────────────── Debug: temporary /api/me helper ─────────────────────────────
   Purpose: load a small debug route that logs incoming SID cookie + a tolerant DB lookup.
   This file is temporary — remove it after diagnosis.
-------------------------------------------------------------------------------------------- */
try {
  // require a JS debug helper (server/src/routes/debug-me-patch.js)
  // use require() to avoid TypeScript module resolution errors for a temporary JS helper
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
  const debugMe = require("./routes/debug-me-patch");
  if (typeof debugMe === "function") {
    // cast to any because the helper expects (app)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    debugMe(app as any);
    console.info("[debug-me-patch] loaded /api/me debug route");
  } else {
    console.warn("[debug-me-patch] module loaded but is not a function");
  }
} catch (err: any) {
  console.warn("[debug-me-patch] not loaded:", err && err.message ? err.message : err);
}

app.set("trust proxy", 1); // required for secure cookies on Render

/* ───────────────────────────── CORS ───────────────────────────── */
// APP_ORIGIN may be, comma-separated: "https://site1.com,http://localhost:3000"
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
    let listEndpoints: any = null;
    try { listEndpoints = require("express-list-endpoints"); } catch { listEndpoints = null; }

    if (listEndpoints) {
      const endpoints = listEndpoints(app);
      return res.json({ ok: true, endpoints });
    }

    const routes: Array<{ method: string; path: string }> = [];
    function walk(stack: any[]) {
      for (const layer of stack) {
        if (layer.route && layer.route.path) {
          const methods = Object.keys(layer.route.methods || {})
            .map((m) => m.toUpperCase())
            .join(",");
          routes.push({ method: methods || "ALL", path: layer.route.path });
        } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
          walk(layer.handle.stack);
        }
      }
    }
    if (app._router && app._router.stack) walk(app._router.stack);
    return res.json({ ok: true, endpoints: routes });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "failed_to_list_routes", message: String(err) });
  }
});
// === end debug routes ===

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
app.use("/login", loginRoute);

app.use("/api/kpis", kpisRouter); 

app.use("/api/tenant/dashboard", tenantDashboardRouter);
app.use("/api/company/dashboard", companyDashboardRouter);

/* ───────────────────────────── Parsers BEFORE routes ───────────────────────────── */
app.use(cookieParser());
// --- FIX: accept legacy cookie 'erp_session' as valid session cookie ---
const CANONICAL_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ||
  process.env.COOKIE_NAME_SID ||
  process.env.COOKIE_NAME ||
  "sid";

app.use((req, res, next) => {
  try {
    if (req?.cookies) {
      if (!req.cookies[CANONICAL_COOKIE_NAME] && req.cookies.erp_session) {
        req.cookies[CANONICAL_COOKIE_NAME] = req.cookies.erp_session;
      }
    }
  } catch (err) {
    console.error("[cookie-compat]", err);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(sessionLoader);

app.use("/api/auth/signup", signupRouter);
app.use("/api", coreRouter);
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

app.use("/api/hms/pharmacy/billing", pharmacyBillingRouter);


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

app.use("/api", kpisTodaysRouter);

app.use("/api/hms/departments", hmsDepartments);


app.use("/api", me);


app.use("/api", pipelines);
app.use("/api", kanban);

/* ---- Mount session + HMS companies/products routers ---- */
app.use("/api/session", sessionRouter);                 // GET /api/session
app.use("/api/hms/companies", companiesRouter);         // GET /api/hms/companies
app.use("/api/hms/products", productsRouter);           // GET /api/hms/products

app.use("/api/settings", settingsRouter);

app.use("/api/accounting", accountingRoutes);
app.use("/api", invoiceRoutes);

/* ------------------------------------------------------ */

/* ───────────────────────────── Admin namespace ───────────────────────────── */
app.use("/api/admin", adminRoutes);
app.use("/api/admin/users", adminUsers);
app.use("/api/admin/roles", adminRolesRouter);
app.use("/api/admin/permissions", adminPermissionsRouter);
app.use("/api/admin/companies", adminCompaniesRouter);
app.use("/api/admin/custom-fields", adminCustomFieldsRouter);
app.use("/api/hms/settings", hmsSettingsRouter);
app.use("/api/hms/patients", hmsPatientsRouter);
app.use("/api/hms", hmsPatientInsights); 
app.use("/api/hms/clinicians", hmsClinicians);
app.use("/api/hms/clinicians", hmsCliniciansRouter);
app.use("/hms/appointments", hmsAppointments);
app.use("/hms/stock", stockRouter);
app.use("/hms/purchases", hmsPurchasesRouter);
app.use("/hms/receipts", hmsReceiptsRouter);
app.use("/hms/invoices", hmsInvoicesRouter);
app.use("/api/hms/roles", rolesRouter);
app.use("/api/hms/specializations", specsRouter);
app.use("/api/leads/sources", leadSourcesRouter);
app.use("/api/leads/professions", leadProfessionsRouter);
app.use("/api/leads/pipelines", leadPipelinesRouter);
app.use("/api/leads/stages", leadStagesRouter);
app.use("/api/leads/industries", leadIndustriesRouter);
app.use("/api", leadsNewRouter);
app.use("/api", leads);
app.use("/api/hms/settings", hmsSettingsRouter);
app.use("/api/global/countries", globalCountriesRouter);   

/* ───────────────────────────── Uploads, Tenants, Scheduler ───────────────────────────── */
app.use("/api/uploads", uploadsRouter);
app.use("/api/tenants", tenantsRouter);
app.use("/api/tenant-signup", tenantSignup); // POST /
app.use("/api/audit-logs", auditLogs);
app.use("/api/scheduler", schedulerRouter);
app.use("/api/global/currencies", globalCurrenciesRouter);
app.use("/api/global/tax-types", globalTaxTypesRouter);
app.use("/api/global/tax-rates", globalTaxRatesRouter);
app.use("/api/global/company-settings", globalCompanySettingsRouter);
app.use("/api/global/company-taxes", globalCompanyTaxesRouter);
app.use("/api/user/companies", userCompaniesRouter);
app.use("/api/onboarding/hms", hmsOnboardingRouter);


// ---- HMS: LAB (LIS)
app.use("/api/hms/lab/orders", labOrdersRouter);      // POST /api/hms/lab/orders
app.use("/api/hms/lab/samples", labSamplesRouter);    // POST /api/hms/lab/samples
app.use("/api/hms/lab/results", labResultsRouter);    // POST /api/hms/lab/results
app.use("/api/hms/lab/worklist", labWorklistRouter);  // GET  /api/hms/lab/worklist

// ---- HMS: IMAGING (RIS / PACS metadata)
app.use("/api/hms/imaging/orders", imagingOrdersRouter);   // POST /api/hms/imaging/orders
app.use("/api/hms/imaging/studies", imagingStudiesRouter); // GET/POST studies, series, images
// optionally provide an aggregate imaging router:
app.use("/api/hms/imaging", imagingRouter);

// ---- HMS: CLINICAL
app.use("/api/hms/encounters", encountersRouter); // POST /api/hms/encounters
app.use("/api/hms/vitals", vitalsRouter);         // POST /api/hms/vitals
app.use("/api/hms/triage", triageRouter);         // POST /api/hms/triage
app.use("/api/hms/notes", notesRouter);           // POST /api/hms/notes
app.use("/api/hms/diagnosis", diagnosisRouter);   // POST /api/hms/diagnosis

// ---- HMS: PROCEDURES
app.use("/api/hms/procedures", proceduresRouter); // full CRUD for procedures

// ---- HMS: PHARMACY
app.use("/api/hms/pharmacy/orders", medOrdersRouter); // POST medication orders
app.use("/api/hms/pharmacy/admin", medAdminRouter);  // POST medication administration (MAR)

// ---- HMS: BILLING
app.use("/api/hms/billing/rules", billingRulesRouter); // billing rule CRUD

// ---- HMS: AI
app.use("/api/hms/ai/tasks", aiTasksRouter); // AI task enqueue / status

// ---- Existing mounts you already have (for reference)
app.use("/api/hms/companies", companiesRouter);
app.use("/api/hms/products", productsRouter);
app.use("/api/hms/settings", hmsSettingsRouter);
app.use("/api/hms/patients", hmsPatientsRouter);
app.use("/api/hms/clinicians", hmsClinicians);
app.use("/api/hms/clinicians", hmsCliniciansRouter);
app.use("/api/hms/roles", rolesRouter);
app.use("/api/hms/specializations", specsRouter);


/* ───────────────────────────── Leads custom fields ───────────────────────────── */
app.use("/api/leads", leadCustomFieldsRouter);

/* ───────────────────────────── Internal healthcheck ───────────────────────────── */
app.get("/api/admin/__health", (_req, res) =>
  res.json({ ok: true, where: "index mount layer" })
);

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
