import { getRestaurantAuthContext } from './restaurant-auth-context'
import { getRestaurantRole, getRestaurantRef } from './restaurant-auth'
import { getLocationAccessRefs } from './disco-restaurant-auth'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The restaurant references the caller may manage promo codes for.
//   ADMIN         → their own restaurant.
//   SYSTEM_ADMIN  → every location with explicit access (disco_restaurant_location_access),
//                   falling back to their own reference when there are no access rows.
//   SUPER_ADMIN (disco-native only — the Disco Cater team) → unrestricted.
//     allowedRefs is meaningless when unrestricted is true; callers must check
//     unrestricted FIRST (see isPromoRefAllowed). FM-session SUPER_ADMIN is
//     unaffected by this — deliberately deferred, see lib/restaurant-write-scope.ts.
export interface PromoScope {
  role: string
  isSystemAdmin: boolean
  unrestricted: boolean
  ownRef: string
  allowedRefs: string[]
  email: string
}

export function isPromoRefAllowed(scope: PromoScope, ref: string): boolean {
  return !!ref && (scope.unrestricted || scope.allowedRefs.includes(ref))
}

export async function resolvePromoScope(): Promise<PromoScope | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null
  const role = ctx.authType === 'disco' ? (ctx.role || 'ADMIN') : (await getRestaurantRole()) || 'ADMIN'
  const ownRef = ctx.authType === 'disco' ? (ctx.restaurantReference || '') : (await getRestaurantRef()) || ''
  const isSystemAdmin = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'
  // Disco-native only, per lib/restaurant-write-scope.ts's model — FM-session
  // SUPER_ADMIN is deliberately left as-is (see that file's header comment).
  const unrestricted = ctx.authType === 'disco' && role === 'SUPER_ADMIN'

  let allowedRefs: string[] = []
  if (unrestricted) {
    // allowedRefs stays empty — isPromoRefAllowed() never consults it for this role.
  } else if (isSystemAdmin) {
    try {
      allowedRefs = (await getLocationAccessRefs(ctx.email)).filter(r => UUID_RE.test(r))
    } catch (e) {
      console.error('[restaurant-promo] location-access lookup failed:', e instanceof Error ? e.message : e)
    }
    if (!allowedRefs.length && UUID_RE.test(ownRef)) allowedRefs = [ownRef]
  } else if (UUID_RE.test(ownRef)) {
    allowedRefs = [ownRef]
  }
  return { role, isSystemAdmin, unrestricted, ownRef, allowedRefs, email: ctx.email }
}
