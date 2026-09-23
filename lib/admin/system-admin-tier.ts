/**
 * Primary vs Regional for the Super Admin System Admins list.
 *
 * Lives here rather than in the route so it can be tested directly; a Next.js
 * route module may only export its HTTP handlers.
 */
export interface TieredAdmin {
  reference?: string
  email?: string
  managedRestaurants?: { reference: string; businessName?: string }[]
  tier?: 'PRIMARY' | 'REGIONAL' | null
  _order?: [number, number]
}

/**
 * PRIMARY vs REGIONAL — a label, not a permission.
 *
 * Peter's definition: Primary is the system admin associated with the group's
 * FIRST restaurant and sees all of the group's locations; Regional admins come
 * later and hold only some. FM models the group explicitly
 * (tbl_restaurant_groups + tbl_restaurant_groups_system_admins) and the rule
 * lands exactly there — the earliest-created admin of a group is one per group
 * across all 153 groups, and every one of them manages that group's first
 * restaurant.
 *
 * FM EXPOSES NONE OF THAT OVER HTTP. There is no group controller and no
 * response DTO carrying a group, and this app cannot reach FM's database. So the
 * group is reconstructed here from the one signal the payload does give:
 * restaurants shared between admins. Two admins holding a restaurant in common
 * are in the same group, transitively.
 *
 * MEASURED AGAINST FM'S OWN TABLES: 343 of 349 grouped admins get the correct
 * label. Six do not, because four reconstructed components merge two real groups
 * that share a restaurant and two real groups split across components. Exactness
 * needs FM's group_id mirrored into Neon — deliberately NOT added here, since
 * this was scoped as a display-only change.
 *
 * Reach is NOT used to decide this. 142 non-founding admins hold every location
 * in their group and would read as Primary on reach alone; ordering separates
 * them correctly. Conversely six founding admins do NOT hold every location and
 * are still Primary.
 *
 * An admin with no locations cannot be placed in any group and gets null rather
 * than a guess.
 */
export function deriveTiers(admins: TieredAdmin[]): void {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x)
    const p = parent.get(x)!
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }

  for (const a of admins) {
    const key = `u:${(a.email || a.reference || '').toLowerCase()}`
    find(key)
    for (const r of a.managedRestaurants || []) if (r?.reference) union(key, `r:${r.reference}`)
  }

  const best = new Map<string, TieredAdmin>()
  const rank = (a: TieredAdmin): [number, number] => a._order ?? [2, Number.MAX_SAFE_INTEGER]
  const earlier = (a: TieredAdmin, b: TieredAdmin) => {
    const [ab, ai] = rank(a), [bb, bi] = rank(b)
    return ab !== bb ? ab < bb : ai < bi
  }
  for (const a of admins) {
    if (!(a.managedRestaurants || []).length) continue
    const comp = find(`u:${(a.email || a.reference || '').toLowerCase()}`)
    const cur = best.get(comp)
    if (!cur || earlier(a, cur)) best.set(comp, a)
  }
  for (const a of admins) {
    if (!(a.managedRestaurants || []).length) { a.tier = null; continue }
    const comp = find(`u:${(a.email || a.reference || '').toLowerCase()}`)
    a.tier = best.get(comp) === a ? 'PRIMARY' : 'REGIONAL'
  }
}
