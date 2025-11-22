// server/src/app.ts
import express from "express";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";

// Import your route(s)
import tenantSignup from "./routes/tenant-signup";

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// mount routes (adjust base path if your app uses /api)
app.use("/", tenantSignup);

// health
app.get("/_health", (_req, res) => res.status(200).json({ ok: true }));

export default app;
