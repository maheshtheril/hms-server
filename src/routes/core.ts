// server/src/routes/core.ts

import { Router } from "express";
import { q } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// Data shape for the database results
interface MenuItemRow {
    id: string;
    parent_id: string | null;
    label: string;
    icon: string;
    url: string; // The URL/path for the menu item
    sort_order: number;
    permission_code: string;
}

// Helper function to transform a flat list into a nested menu tree
function buildMenuTree(items: MenuItemRow[], parentId: string | null = null): any[] {
    return items
        // 1. Filter for items belonging to the current parentId
        .filter(item => (item.parent_id === parentId || (item.parent_id === null && parentId === null)))
        // 2. Sort them by the explicit sort_order column
        .sort((a, b) => a.sort_order - b.sort_order)
        // 3. Map to the final structure and recursively find children
        .map(item => ({
            id: item.id,
            label: item.label,
            path: item.url, // Use 'url' as the path for the frontend
            icon: item.icon,
            permission_code: item.permission_code,
            children: buildMenuTree(items, item.id), // Recursive call for children
        }));
}

/**
 * GET /api/menu
 * Returns the navigation menu structure for the logged-in user, fetched from the database.
 * * FIXES: GET /api/menu 404 (Not Found)
 */
router.get("/menu", requireAuth, async (_req, res) => {
    try {
        // Query to fetch all global menu items.
        // Note: For a real system, you might need complex joins (e.g., with module_menu_map)
        // to filter by modules enabled for the current tenant.
        const { rows } = await q(
            `SELECT id, parent_id, label, icon, url, sort_order, permission_code
             FROM public.menu_items
             WHERE is_global = TRUE -- Assuming initial menu items are global
             ORDER BY sort_order ASC, label ASC`,
            []
        );

        // Build the hierarchical menu structure
        const menuTree = buildMenuTree(rows as MenuItemRow[]);

        res.json({ menu: menuTree });

    } catch (error) {
        console.error("[GET /api/menu] Database error:", error);
        res.status(500).json({ error: "Failed to fetch menu items from database" });
    }
});

/**
 * GET /api/perms/menu
 * Returns the menu data needed for permission-based rendering (a flat list of paths/codes).
 * * FIXES: GET /api/perms/menu 404 (Not Found)
 */
router.get("/perms/menu", requireAuth, async (_req, res) => {
    try {
        // Fetch a flat list containing only ID, path (url), and permission code.
        const { rows } = await q(
            `SELECT id, url AS path, permission_code
             FROM public.menu_items
             WHERE is_global = TRUE`,
            []
        );

        // The frontend expects a flat list for permission checks
        res.json({ menu: rows });

    } catch (error) {
        console.error("[GET /api/perms/menu] Database error:", error);
        res.status(500).json({ error: "Failed to fetch permission menu items from database" });
    }
});


export default router;