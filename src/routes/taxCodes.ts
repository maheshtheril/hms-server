// routes/taxCodes.ts
import express, { Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import createDebug from "debug";
import dotenv from "dotenv";

dotenv.config();
const debug = createDebug("hms:tax-codes");

const router = express.Router();

// --- Environment / DB pool (configure via env) ---
const {
  DATABASE_URL,
  JWT_SECRET = "replace_with_real_secret",
  SESSION_TABLE = "sessions",
} = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set in environment");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // optionally set ssl: { rejectUnauthorized: false } for some hosts
});

// --- Types ---
type JwtPayload = {
  userId: string;
  companyId?: string;
  iat?: number;
  exp?: number;
};

// Attach user/company info to Request
declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        companyId?: string;
        sessionId?: string;
      };
    }
  }
}

// --- Helpers ---

/**
 * Extract Bearer token from Authorization header and verify JWT.
 * Returns payload or null.
 */
async function verifyBearerToken(authHeader?: string): Promise<JwtPayload | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return payload;
  } catch (err) {
    debug("JWT verify error:", err);
    return null;
  }
}

/**
 * Try to load session from cookie string (connect.sid or custom).
 * Assumes `sessions` table has columns: sid (text), sess (jsonb), user_id (uuid) optional, company_id (uuid) optional, expires (timestamp)
 * Adjust SQL to match your sessions schema.
 */
async function loadSessionFromCookie(cookieHeader?: string): Promise<{ sessionId: string; userId?: string; companyId?: string } | null> {
  if (!cookieHeader) return null;
  const parsed = cookie.parse(cookieHeader || "");
  // common cookie name used by express-session:
  const sid = parsed["connect.sid"] || parsed["sid"] || parsed["session"];
  if (!sid) return null;

  // If your session cookie is signed (like s:xxxxx.signature), strip prefix
  const rawSid = sid.startsWith("s:") ? sid.split(".")[0].slice(2) : sid;

  const sql = `
    SELECT sid, sess, (sess->>'userId') as user_id, (sess->>'companyId') as company_id, expires
    FROM ${SESSION_TABLE}
    WHERE sid = $1
    LIMIT 1
  `;
  try {
    const res = await pool.query(sql, [rawSid]);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    // If session JSON stores user/company under different keys, adapt here.
    const userId = row.user_id ?? (row.sess && row.sess.userId) ?? undefined;
    const companyId = row.company_id ?? (row.sess && row.sess.companyId) ?? undefined;
    // Optionally check expiry:
    if (row.expires && new Date(row.expires) < new Date()) {
      debug("session expired:", rawSid);
      return null;
    }
    return { sessionId: rawSid, userId, companyId };
  } catch (err) {
    debug("loadSessionFromCookie error", err);
    return null;
  }
}

// --- Auth middleware: supports Bearer JWT or session cookie ---
async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    // 1) Try bearer token
    const bearerPayload = await verifyBearerToken(req.header("authorization") || "");
    if (bearerPayload && bearerPayload.userId) {
      req.auth = {
        userId: bearerPayload.userId,
        companyId: bearerPayload.companyId,
      };
      return next();
    }

    // 2) Try session cookie
    const cookieHeader = req.header("cookie");
    const session = await loadSessionFromCookie(cookieHeader || "");
    if (session && session.userId) {
      req.auth = {
        userId: session.userId,
        companyId: session.companyId,
        sessionId: session.sessionId,
      };
      return next();
    }

    // 3) No auth
    return res.status(401).json({ error: "Unauthorized" });
  } catch (err) {
    debug("authMiddleware error", err);
    return res.status(500).json({ error: "Internal auth error" });
  }
}

// --- Route: GET /tax-codes ---
// Query behavior (opinionated):
// - If caller is authenticated and request has no query params, return tax codes for their company (companyId from JWT/session).
// - Optionally accept `?companyId=...` if the authenticated user has permission (simple check: same company).
// - Accept `?q=` to search by code or name (ILIKE %q%).
router.get("/tax-codes", authMiddleware, async (req: Request, res: Response) => {
  const auth = req.auth!;
  const { companyId: qCompanyId, q } = req.query;

  try {
    // Determine target companyId
    const targetCompanyId = (typeof qCompanyId === "string" && qCompanyId.length > 0) ? qCompanyId : auth.companyId;
    if (!targetCompanyId) {
      return res.status(400).json({ error: "companyId required (either in your token/session or as query param)" });
    }

    // Security check: ensure user belongs to company (simple check)
    if (auth.companyId && auth.companyId !== targetCompanyId) {
      // More complex permission logic belongs here.
      return res.status(403).json({ error: "Forbidden: cannot access tax codes for this company" });
    }

    // Build query
    let sql = `
      SELECT id, company_id, code, name, rate, description, active, created_at, updated_at
      FROM hms_tax_codes
      WHERE company_id = $1
    `;
    const params: any[] = [targetCompanyId];

    if (typeof q === "string" && q.trim().length > 0) {
      sql += ` AND (code ILIKE $2 OR name ILIKE $2 OR description ILIKE $2)`;
      params.push(`%${q.trim()}%`);
    }

    sql += ` ORDER BY code ASC NULLS LAST, name ASC LIMIT 1000;`;

    const dbRes = await pool.query(sql, params);
    const items = dbRes.rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      code: r.code,
      name: r.name,
      rate: Number(r.rate),
      description: r.description,
      active: Boolean(r.active),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return res.json({ count: items.length, items });
  } catch (err) {
    debug("GET /tax-codes error:", err);
    return res.status(500).json({ error: "Failed to load tax codes" });
  }
});

export default router;
