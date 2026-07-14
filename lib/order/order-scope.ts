import { sql } from '../db'
import type { RestaurantAuthContext } from '../restaurant-auth-context'
import { getLocationAccessRefs } from '../disco-restaurant-auth'
import { getRestaurantRef } from '../restaurant-auth'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The full set of restaurant references the authenticated caller may act on.
// Mirrors the scoping the orders LIST route uses (app/api/restaurant/orders/route.ts):
//   - disco ADMIN                        → own restaurant only
//   - disco SYSTEM_ADMIN / SUPER_ADMIN   → every location in
//       disco_restaurant_location_access for their email, PLUS the home ref
//   - FM session                         → the FM JWT's restaurant, or the
//       selected-location cookie for FM SAs (getRestaurantRef handles both)
// Refs are normalized to lowercase strings so membership tests sidestep the
// disco_orders.restaurant_reference UUID vs disco_restaurant_location_access TEXT
// cast footgun. Never widens the set on a lookup error (keeps home ref only).
export async function getCallerScopeRefs(ctx: RestaurantAuthContext): Promise<Set<string>> {
  const set = new Set<string>()
  const add = (r: string | null | undefined) => {
    const v = (r || '').trim().toLowerCase()
    if (v && UUID_RE.test(v)) set.add(v)
  }

  if (ctx.authType === 'disco') {
    add(ctx.restaurantReference)
    if (ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN') {
      try {
        for (const r of await getLocationAccessRefs(ctx.email)) add(r)
      } catch {
        /* keep the home ref only — never widen access on error */
      }
    }
  } else {
    add(await getRestaurantRef())
  }
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
