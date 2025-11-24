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
import { buildMenuTree } from "../services/menuService";
import { requireAuth } from "../middleware/requireAuth"; 

const router = Router();

/**
 * GET /api/menu
 * Returns the navigation menu for the current user/tenant.
 */
router.get("/menu", requireAuth, async (req: Request, res: Response) => {
  
  // 1. FIX for 502 Crash: Use req.authSession instead of req.session
  const authSession = req.authSession;

  if (!authSession?.user_id || !authSession?.tenant_id) {
    return res.status(401).json({ error: "Missing user or tenant context" });
  }

  try {
    // 2. 💥 FINAL FIX for ALL TypeScript errors: 
    // Provide all four mandatory properties with their specific type constructors.
    const menuTree = await buildMenuTree({
        // Assumed Array: Fixes 'items' missing
        items: [],                 
        // REQUIRED Set<string>: Fixes 'moduleMap' missing
        moduleMap: new Set<string>(), 
        // ⬅️ REQUIRED Set<string>: Fixes 'permissions' missing (the latest error)
        permissions: new Set<string>(), 
        // Assumed Array: Fixes 'overrides' missing
        overrides: []              
    }); 

    res.json({ menu: menuTree });
  } catch (error) {
    console.error("Error fetching menu:", error);
    res.status(500).json({ error: "Failed to load menu data" });
  }
});

export default router;