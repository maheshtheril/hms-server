/**
 * Build final menu tree
 * Filters:
 *  - permission_code
 *  - tenant module_enable
 *  - overrides (hide/label/url)
 */

export function buildMenuTree({
  items,
  moduleMap,
  permissions,
  overrides,
}: {
  items: any[];
  moduleMap: any[];
  permissions: Set<string>;
  overrides: any[];
}) {
  // convert override rows to fast lookup
  const overrideMap = new Map<string, any>();
  overrides.forEach((o) => overrideMap.set(o.menu_item_id, o));

  // apply permission + overrides filtering
  const filtered = items
    .filter((item) => {
      // permission check
      if (item.permission_code) {
        if (!permissions.has(item.permission_code)) return false;
      }

      // override hide
      const ov = overrideMap.get(item.id);
      if (ov?.is_hidden === true) return false;

      return true;
    })
    .map((item) => {
      // apply override label/url/icon if present
      const ov = overrideMap.get(item.id);
      return {
        id: item.id,
        parent_id: item.parent_id,
        module_key: item.module_key,
        key: item.key,
        label: ov?.custom_label || item.label,
        icon: ov?.custom_icon || item.icon,
        url: ov?.custom_url || item.url,
        sort_order: item.sort_order,
        permission_code: item.permission_code,
      };
    });

  // build tree
  const byParent: Record<string, any[]> = {};
  filtered.forEach((item) => {
    const pid = item.parent_id || "root";
    if (!byParent[pid]) byParent[pid] = [];
    byParent[pid].push(item);
  });

  const sortItems = (arr: any[]) =>
    arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  function build(parentId: string) {
    const children = byParent[parentId] || [];
    return sortItems(children).map((child) => ({
      ...child,
      children: build(child.id),
    }));
  }

  return build("root");
}
