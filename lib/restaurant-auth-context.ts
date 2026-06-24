import { cookies } from 'next/headers'
import { validateDiscoRestaurantSession } from './disco-restaurant-auth'
import { getFmServiceAuthHeader } from './fm-service-auth'

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
