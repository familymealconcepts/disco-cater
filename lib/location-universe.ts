/**
 * The locations an admin can reach, and which STORE each one lives in.
 *
 * Used by every fan-out surface that operates across a whole group and can
 * therefore straddle the conversion boundary: bulk-pricing search and apply,
 * and multi-unit link creation.
 *
 * ── THE MIXED GROUP ─────────────────────────────────────────────────────────
 * Conversion runs location by location, so a chain is mixed for as long as it
 * takes to finish. Measured on 2026-09-16: of 82 multi-location brands, 17 are
 * mid-conversion — 134 locations, 49 already native and 85 still FM-backed.
 * That is the normal state of a converting chain, not an edge case.
 *
 * Both bulk-pricing routes used to pick their data source from the SESSION
 * (`ctx.authType === 'disco'`), which gets a mixed group wrong in both
 * directions:
 *
 *   - From an FM session the FM branch read FM's public menu endpoints for
 *     every location including converted ones. A converted restaurant's FM menu
 *     is frozen at conversion, so the search showed STALE prices, and the apply
 *     wrote the new price into a record nothing reads — returning ok:true while
 *     the live native price never moved.
 *
 *   - From a Disco session the native branch's universe was the Disco group
 *     only, so unconverted siblings were absent from the search entirely and
 *     apply refused them with "Location not in your group".
 *
 * The fix is the same rule as everywhere else: decide from the RESTAURANT.
 * Native locations resolve against Neon, FM-backed ones against FamilyMeal,
 * in one search, whichever way the caller signed in.
 *
 * ── WHAT THIS CANNOT DO ─────────────────────────────────────────────────────
 * A Disco-native account holds no FM token, so Disco has no way to authorize a
 * read or write against an FM-backed sibling. Those locations are returned in
 * `unreadable` with a reason instead of being silently dropped — the caller
 * reports them, so an operator is never shown a short list that looks complete.
 */
import { getRestaurantAuthContext } from './restaurant-auth-context'
import { getRestaurantRole, getRestaurantHomeRef, getFmSystemAdminPermittedRefs } from './restaurant-auth'
import { getDiscoGroupAccounts, getLocationAccessRefs } from './disco-restaurant-auth'
import { sql } from './db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ScopeLocation { ref: string; name: string; native: boolean }
export interface LocationUniverse {
  role: string
  isSuperAdmin: boolean
  /** Every location in reach, with the store that owns its menu. */
  locations: ScopeLocation[]
  /** Raw FM Authorization header when this session has one, else null. */
  fmAuth: Record<string, string> | null
  /** In reach but not readable from this session, with why. */
  unreadable: Array<{ ref: string; name: string; reason: string }>
}

/**
 * Resolve the caller's location universe, unioned across BOTH sources rather
 * than picking one by session type: FamilyMeal's own system-admin list (its
 * authorization decision, when the session carries an FM token) and Disco's
 * group + explicit ACL. A location in either is in reach.
 */
export async function resolveLocationUniverse(): Promise<LocationUniverse | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null

  const role = ctx.authType === 'disco' ? (ctx.role || 'ADMIN') : (await getRestaurantRole()) || 'ADMIN'
  const isSuperAdmin = role === 'SUPER_ADMIN'
  if (role !== 'SYSTEM_ADMIN' && !isSuperAdmin) {
    return { role, isSuperAdmin, locations: [], fmAuth: null, unreadable: [] }
  }

  const refs = new Set<string>()
  const add = (r: string | null | undefined) => { if (r && UUID_RE.test(r)) refs.add(r) }

  add(ctx.authType === 'disco' ? ctx.restaurantReference : await getRestaurantHomeRef().catch(() => ''))

  // FamilyMeal's own answer, when there is a token to ask with. Note FM's
  // SYSTEM_ADMIN controller denies SUPER_ADMIN outright, so a SUPER_ADMIN FM
  // session gets an empty set back — that is FM's model, not a failure here.
  const fmAuth = ctx.fmToken ? { Authorization: ctx.fmToken } : null
  if (ctx.fmToken) {
    try { for (const r of await getFmSystemAdminPermittedRefs(ctx.fmToken)) add(r) } catch { /* never widen on error */ }
  }

  // Disco's own group and explicit ACL.
  if (ctx.email) {
    try { for (const g of await getDiscoGroupAccounts(ctx.businessName, ctx.email)) add(g.restaurant_reference) } catch { /* home only */ }
    try { for (const r of await getLocationAccessRefs(ctx.email)) add(r) } catch { /* home only */ }
  }

  // A SUPER_ADMIN is unrestricted, and native menus are one cheap Neon query, so
  // widen to every native restaurant. FM-backed locations are NOT widened: that
  // would be ~4,000 menu traversals against FamilyMeal per search.
  if (isSuperAdmin) {
    try {
      const all = (await sql`SELECT restaurant_reference FROM disco_restaurant_cache WHERE is_disco_native = true AND archived_at IS NULL`) as Array<{ restaurant_reference: string }>
      for (const r of all) add(r.restaurant_reference)
    } catch { /* keep the concrete set */ }
  }

  if (!refs.size) return { role, isSuperAdmin, locations: [], fmAuth, unreadable: [] }

  const list = [...refs]
  const rows = (await sql`
    SELECT restaurant_reference::text AS ref, name, COALESCE(is_disco_native, false) AS native
      FROM disco_restaurant_cache
     WHERE restaurant_reference::text = ANY(${list}) AND archived_at IS NULL
  `) as Array<{ ref: string; name: string | null; native: boolean }>
  const known = new Map(rows.map(r => [r.ref, { ref: r.ref, name: r.name || '', native: !!r.native }]))

  const locations: ScopeLocation[] = []
  const unreadable: LocationUniverse['unreadable'] = []
  for (const ref of list) {
    // Not in the cache at all — an FM restaurant Disco has never mirrored. It is
    // still in reach and still readable through FM, so treat it as FM-backed.
    const loc = known.get(ref) || { ref, name: '', native: false }
    if (!loc.native && !fmAuth) {
      unreadable.push({ ref, name: loc.name, reason: 'FM-backed location, and this Disco session holds no FamilyMeal token' })
      continue
    }
    locations.push(loc)
  }
  locations.sort((a, b) => a.name.localeCompare(b.name))
  return { role, isSuperAdmin, locations, fmAuth, unreadable }
}

/** Is this ref in reach? SUPER_ADMIN is unrestricted, matching resolveWriteScope. */
export function scopeAllows(scope: LocationUniverse, ref: string): boolean {
  if (!ref || !UUID_RE.test(ref)) return false
  if (scope.isSuperAdmin) return true
  return scope.locations.some(l => l.ref === ref) || scope.unreadable.some(u => u.ref === ref)
}

/** Is this specific restaurant native? Reads the authoritative cache column. */
export async function refIsNative(ref: string): Promise<boolean> {
  const rows = (await sql`SELECT COALESCE(is_disco_native, false) AS native FROM disco_restaurant_cache WHERE restaurant_reference::text = ${ref} LIMIT 1`) as Array<{ native: boolean }>
  return rows.length ? !!rows[0].native : false
}
