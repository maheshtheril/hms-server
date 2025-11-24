// src/routes/menu.ts
// ... imports and global type augmentation ...
export {};
import { Router, Request, Response } from "express";
import { buildMenuTree } from "../services/menuService";
import { requireAuth } from "../middleware/requireAuth"; 

const router = Router();

router.get("/menu", requireAuth, async (req: Request, res: Response) => {
  
  const authSession = req.authSession; // FIX: Use req.authSession

  if (!authSession?.user_id || !authSession?.tenant_id) {
    return res.status(401).json({ error: "Missing user or tenant context" });
  }

  try {
    // FIX: Pass all mandatory properties with correct types
    const menuTree = await buildMenuTree({
        items: [],                 
        moduleMap: new Set<string>(), 
        permissions: new Set<string>(), 
        overrides: []              
    }); 

    res.json({ menu: menuTree });
  } catch (error) {
    console.error("Error fetching menu:", error);
    res.status(500).json({ error: "Failed to load menu data" });
  }
});

export default router;