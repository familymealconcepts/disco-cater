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
      // A Disco user MAY also carry an FM token (if they logged into FM before);
      // when present we prefer it so FM calls stay session-scoped.
      const fmToken = cookieStore.get('fm_restaurant_token')?.value ?? null
      return { ...session, authType: 'disco', fmToken }
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
