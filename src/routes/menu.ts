// src/routes/menu.ts
// --- quick local augmentation to satisfy TS until global .d.ts is picked up ---
declare global {
  namespace Express {
    interface Request {
      authSession?: {
        sid?: string | null;
        user_id?: string | null;
        tenant_id?: string | null;
        company_id?: string | null;
        is_admin?: boolean;
        is_tenant_admin?: boolean;
        is_platform_admin?: boolean;
        email?: string | null;
        name?: string | null;
        issued_at?: string | null;
        last_seen?: string | null;
      };
    }
  }
}
// ensure module context so `declare global` is allowed in this file
export {};
// ------------------------------------------------
// now your normal imports below
import { Router, Request, Response } from "express";
import { pool } from "../db";
import { buildMenuTree } from "../services/menuService";
import type { PoolClient } from "pg";
