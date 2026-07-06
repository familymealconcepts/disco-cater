// Which sidebar nav path is active for a given URL. Picks the SINGLE most-specific
// (longest) matching path across all top-level items + their children, so a parent
// path that is a prefix of a sibling — e.g. "Manage Menus" (/restaurant/menu-manager)
// vs Settings (/restaurant/menu-manager/settings) — never stays highlighted on the
// sibling's page. Returns '' when nothing matches.
export interface NavPathItem { path: string; children?: { path: string }[] }

export function computeActivePath(nav: NavPathItem[], pathname: string): string {
  return nav
    .flatMap(i => [i.path, ...(i.children?.map(c => c.path) ?? [])])
    .filter(p => pathname === p || (p !== '/restaurant' && pathname.startsWith(p + '/')))
    .reduce((best, p) => (p.length > best.length ? p : best), '')
}
