import { sql } from '../db'
import { getRestaurantAuthContext, type RestaurantAuthContext } from '../restaurant-auth-context'
import { getAdminAuthHeader } from '../admin-auth'
import { getRestaurantRef } from '../restaurant-auth'
import { resolveDiscoAccessScope } from '../restaurant-write-scope'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A Set that reports having every ref — used for the unrestricted (disco-
// native SUPER_ADMIN) case below so assertOrderInScope's `scope.has(owner)`
// check needs no special-casing. size is reported non-zero so the existing
// "empty scope → fail closed" guard in assertOrderInScope doesn't trip.
class UnrestrictedRefSet extends Set<string> {
  has(): boolean { return true }
  get size(): number { return 1 }
}

// The full set of restaurant references the authenticated caller may act on.
// Mirrors the scoping the orders LIST route uses (app/api/restaurant/orders/route.ts):
//   - disco ADMIN                        → own restaurant only
//   - disco SYSTEM_ADMIN                 → every location in
//       disco_restaurant_location_access for their email, PLUS the home ref
//   - disco SUPER_ADMIN (Disco Cater team) → unrestricted
//   - FM session                         → the FM JWT's restaurant, or the
//       selected-location cookie for FM SAs (getRestaurantRef handles both).
//       FM-session scoping is deliberately left as-is — see
//       lib/restaurant-write-scope.ts's header comment.
// Refs are normalized to lowercase strings so membership tests sidestep the
// disco_orders.restaurant_reference UUID vs disco_restaurant_location_access TEXT
// cast footgun. Never widens the set on a lookup error (keeps home ref only).
export async function getCallerScopeRefs(ctx: RestaurantAuthContext): Promise<Set<string>> {
  if (ctx.authType === 'disco') {
    const scope = await resolveDiscoAccessScope(ctx)
    if (scope.unrestricted) return new UnrestrictedRefSet()
    const set = new Set<string>()
    for (const r of scope.refs) {
      const v = (r || '').trim().toLowerCase()
      if (v && UUID_RE.test(v)) set.add(v)
    }
    return set
  }
  const set = new Set<string>()
  const v = ((await getRestaurantRef()) || '').trim().toLowerCase()
  if (v && UUID_RE.test(v)) set.add(v)
  return set
}

export interface OrderScopeResult {
  ok: boolean
  /** The order's owning restaurant_reference (lowercased) when ok. */
  restaurantRef?: string
}

// Assert that the order identified by `ref` (a disco reference OR an
// fm_order_reference) belongs to a restaurant the caller may act on.
//
// The owning restaurant_reference is resolved from disco_orders, which holds BOTH
// disco-native orders and FM-backed orders mirrored/synced from FamilyMeal — and
// the orders LIST route syncs a restaurant's FM orders into Neon before they are
// ever shown or acted on, so any order a restaurant can legitimately reach is
// present here. Fail-closed: an order not found in Neon, or owned by a restaurant
// outside the caller's scope, returns { ok:false } — callers translate that to a
// 404 (never a 403, so a foreign reference is not confirmed to exist).
//
// Enforce this BEFORE any DB mutation, Stripe call, or FM proxy in a [ref] route.
export async function assertOrderInScope(
  ref: string,
  ctx: RestaurantAuthContext,
): Promise<OrderScopeResult> {
  if (!UUID_RE.test(ref)) return { ok: false }

  const scope = await getCallerScopeRefs(ctx)
  if (scope.size === 0) return { ok: false } // fail closed — no resolvable scope

  let owner = ''
  try {
    const rows = (await sql`
      SELECT restaurant_reference::text AS ref
      FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as Array<{ ref: string | null }>
    owner = (rows[0]?.ref || '').trim().toLowerCase()
  } catch {
    owner = ''
  }

  if (!owner) return { ok: false }
  return scope.has(owner) ? { ok: true, restaurantRef: owner } : { ok: false }
}


export interface OrderAccess {
  ok: boolean
  /** Status to return when !ok — 401 (no credentials) or 404 (out of scope). */
  status: 401 | 404 | null
  error: string | null
  /** True when the caller holds an admin token, regardless of any restaurant cookie. */
  isAdmin: boolean
  ctx: RestaurantAuthContext | null
  /** The order's owning restaurant_reference — only for a scoped restaurant caller. */
  restaurantRef?: string
}

// Single entry point for "may this caller act on this order?", shared by the
// [ref] routes the super-admin edit page drives (details, edit-status, edit).
//
// Admin credentials are resolved INDEPENDENTLY of whether a restaurant cookie
// happens to be present. Each of those routes used to key the admin exemption
// off `!ctx` — "no restaurant session, therefore this must be the admin portal".
// That assumption broke the moment an admin's browser also held a restaurant
// cookie: getRestaurantAuthContext() returned that session, the admin branch was
// never reached, and the admin was silently demoted to that restaurant's scope,
// 404ing every order outside it (e2ae0c6 introduced this; it made super-admin
// order editing fail on 100% of orders for any admin logged into a non-
// SUPER_ADMIN restaurant account).
//
// The trust model is unchanged: a valid admin token still means admin, exactly
// as the old admin branch treated it. Only the TIMING of the check moved. A
// caller without an admin token takes a path byte-for-byte identical to before,
// including 404 (never 403) on a foreign reference, so a probe cannot confirm
// an order exists.
export async function resolveOrderAccess(ref: string): Promise<OrderAccess> {
  const ctx = await getRestaurantAuthContext()

  let isAdmin = false
  try { await getAdminAuthHeader(); isAdmin = true } catch { /* not an admin caller */ }
  if (isAdmin) return { ok: true, status: null, error: null, isAdmin: true, ctx }

  if (!ctx) return { ok: false, status: 401, error: 'Not authenticated', isAdmin: false, ctx: null }

  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return { ok: false, status: 404, error: 'Order not found', isAdmin: false, ctx }
  return { ok: true, status: null, error: null, isAdmin: false, ctx, restaurantRef: scope.restaurantRef }
}
