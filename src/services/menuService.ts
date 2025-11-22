/**
 * Build final menu tree
 * Filters based on:
 *  - permission_code
 *  - enabled tenant modules
 *  - overrides (hide/label/url/icon)
 */

export interface MenuItemRow {
  id: string;
  parent_id?: string | null;
  module_key?: string | null;
  key?: string | null;
  label: string;
  icon?: string | null;
  url?: string | null;
  sort_order?: number | null;
  permission_code?: string | null;
}

export interface MenuOverrideRow {
  menu_item_id: string;
  is_hidden?: boolean;
  custom_label?: string | null;
  custom_icon?: string | null;
  custom_url?: string | null;
}

export interface BuildMenuTreeArgs {
  items: MenuItemRow[];
  moduleMap: Set<string>;        // tenant-enabled modules
  permissions: Set<string>;      // permission codes
  overrides: MenuOverrideRow[];
}

export function buildMenuTree({
  items,
  moduleMap,
  permissions,
  overrides,
}: BuildMenuTreeArgs) {
  // Fast override lookup
  const overrideMap = new Map<string, MenuOverrideRow>();
  for (const o of overrides) overrideMap.set(o.menu_item_id, o);

  // Step 1: filter + apply overrides
  const filtered = items
    .filter((item) => {
      // permission filter
      if (item.permission_code && !permissions.has(item.permission_code)) {
        return false;
      }

      // module filter
      if (item.module_key && !moduleMap.has(item.module_key)) {
        return false;
      }

      // override: hidden
      const ov = overrideMap.get(item.id);
      if (ov?.is_hidden === true) return false;

      return true;
    })
    .map((item) => {
      const ov = overrideMap.get(item.id);
      return {
        id: item.id,
        parent_id: item.parent_id || null,
        module_key: item.module_key || null,
        key: item.key || null,
        label: ov?.custom_label ?? item.label,
        icon: ov?.custom_icon ?? item.icon,
        url: ov?.custom_url ?? item.url,
        sort_order: item.sort_order ?? 0,
        permission_code: item.permission_code || null,
      };
    });

  // Step 2: group by parent
  const childrenByParent: Record<string, MenuItemRow[]> = Object.create(null);

  for (const item of filtered) {
    const pid = item.parent_id ?? "root";
    if (!childrenByParent[pid]) childrenByParent[pid] = [];
    childrenByParent[pid].push(item);
  }

  // Step 3: recursive builder
  const build = (parentId: string): any[] => {
    const children = childrenByParent[parentId] || [];
    children.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    return children.map((child) => ({
      ...child,
      children: build(child.id),
    }));
  };

  return build("root");
}
