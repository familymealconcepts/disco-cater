import { cookies } from 'next/headers'
import { validateDiscoRestaurantSession, getDiscoGroupAccounts } from './disco-restaurant-auth'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { SELECTED_RESTAURANT_COOKIE } from './restaurant-auth'

export interface RestaurantAuthContext {
  restaurantReference: string
  email: string
  firstName: string | null
  lastName: string | null
  restaurantName: string | null
  authType: 'disco' | 'fm'
  fmToken: string | null // FM token if available, null for Disco-only users
  // Disco-native role + group. Only meaningful for authType 'disco'; FM users
  // resolve their role from the JWT via getRestaurantRole() instead.
  role: string | null
  businessName: string | null
}

// Resolves the restaurant request context from either auth system. Disco-native
// sessions win when present; otherwise we fall back to the legacy FM cookie.
export async function getRestaurantAuthContext(): Promise<RestaurantAuthContext | null> {
  const cookieStore = await cookies()

  // Try Disco-native session first.
  const discoToken = cookieStore.get('disco_restaurant_token')?.value
  if (discoToken) {
    const session = await validateDiscoRestaurantSession(discoToken)
    if (session) {
      // Disco session always uses the service account scoped to its own
      // restaurantReference — never defer to a stale FM token left in the browser
      // (that's how a new partner ended up seeing a prior FM restaurant).
      return { ...session, authType: 'disco', fmToken: null, role: session.role, businessName: session.businessName }
    }
  }

  // Fall back to FM token.
  const fmToken = cookieStore.get('fm_restaurant_token')?.value
  if (fmToken) {
    return {
      restaurantReference: '', // resolved per-request from the FM token
      email: '',
      firstName: null,
      lastName: null,
      restaurantName: null,
      authType: 'fm',
      fmToken,
      role: null,
      businessName: null,
    }
  }

  return null
}

// FM auth header for a restaurant request: the user's own FM token when present,
// otherwise the SUPER_ADMIN service account (for Disco-only users with no FM
// token). Routes call this and get the right credential automatically.
export async function getFmHeaderForRestaurant(ctx: RestaurantAuthContext): Promise<Record<string, string>> {
  if (ctx.fmToken) return { Authorization: ctx.fmToken }
  return getFmServiceAuthHeader()
}

// True when the request must go through FM's SUPER_ADMIN (/api/admin/*) endpoints
// scoped by restaurantReference — i.e. a Disco-only user with no FM token. This
// is exactly when getFmHeaderForRestaurant returns the service-account header.
export function usesServiceAccount(ctx: RestaurantAuthContext): boolean {
  return ctx.authType === 'disco' && !ctx.fmToken && !!ctx.restaurantReference
}

// The restaurant reference a Disco portal request should actually operate on for
// Neon-native resources (e.g. the disco-menus stack).
//
// A Disco SYSTEM_ADMIN manages many locations: in the portal they pick one
// ("View as Restaurant User"), which stores the choice in the
// fm_selected_restaurant cookie. Neon menu routes must scope to that SELECTED
// location, not the SA's home account — otherwise a multi-location admin can only
// ever see/edit their home location's menus.
//
// Security + fail-safe. The selected ref is honored based on role:
//   - SUPER_ADMIN (the Disco Cater team) is unrestricted — any selected ref is
//     honored with no group-membership check. This matches FM's own model:
//     FM's SUPER_ADMIN has its own unrestricted controller with no per-restaurant
//     ACL (see getRestaurantRef's comment in lib/restaurant-auth.ts for the FM
//     side of this same correction), so there is no "permitted set" to check
//     a disco-native SUPER_ADMIN against either — the role itself is the
//     authorization. The settled model: SUPER_ADMIN = Disco Cater team
//     (unrestricted), SYSTEM_ADMIN = restaurant owner (scoped to their locations).
//   - SYSTEM_ADMIN is honored only when the ref is within their own group/access
//     set (getDiscoGroupAccounts — the same source used for order/location
//     scoping). A plain ADMIN has one location and never trusts the cookie.
// Any doubt for SYSTEM_ADMIN — no cookie, an unknown/foreign ref, or a lookup
// error — resolves to the session's home reference. A cookie value is never
// trusted alone for that role.
export async function resolveDiscoScopeRef(ctx: RestaurantAuthContext): Promise<string> {
  const home = ctx.restaurantReference
  if (ctx.authType !== 'disco' || !home) return home
  const cookieStore = await cookies()
  const selected = (cookieStore.get(SELECTED_RESTAURANT_COOKIE)?.value || '').trim()
  if (ctx.role === 'SUPER_ADMIN') return selected || home
  if (ctx.role !== 'SYSTEM_ADMIN') return home
  if (!selected || selected === home) return home
  try {
    const group = await getDiscoGroupAccounts(ctx.businessName, ctx.email)
    if (group.some(g => g.restaurant_reference === selected)) return selected
  } catch { /* fall through to home — never widen access on error */ }
  return home
}
