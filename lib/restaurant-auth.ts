import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'

export const RESTAURANT_TOKEN_COOKIE = 'fm_restaurant_token'
export const RESTAURANT_REFRESH_COOKIE = 'fm_restaurant_refresh'
export const SELECTED_RESTAURANT_COOKIE = 'fm_selected_restaurant'

export const RESTAURANT_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

// For Route Handlers — uses next/headers for reliable server-side access
export async function getRestaurantToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}

// Auth header helper — throws if token is missing
// FM API expects raw JWT: Authorization: <token> (no Bearer prefix)
export async function getRestaurantAuthHeader(): Promise<Record<string, string>> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) throw new Error('Not authenticated')
  return { Authorization: token }
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Decode the current user's reference from the JWT. FM's MultiUnitLinks DTOs
// require `userReference` to be a UUID, and FM's listing call validates it too.
// The JWT's `sub` claim is the user's EMAIL (e.g. "chef@familymeal.com"), NOT a
// UUID — sending it made FM reject both create-link and fetch-links. So we only
// accept a UUID-shaped user claim, and fall back to the restaurant UUID
// (getRestaurantRef) when the token carries no user UUID. Never returns the email.
export async function getRestaurantUserRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  const candidates = [payload?.reference, payload?.userReference, payload?.userRef, payload?.uid, payload?.id]
  for (const c of candidates) {
    if (typeof c === 'string' && UUID_RE.test(c)) return c
  }
  return await getRestaurantRef()
}

// Decode role from JWT payload field 'role'
export async function getRestaurantRole(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  return (payload?.role as string) || null
}

// Decode restaurant reference UUID. For SYSTEM_ADMIN/SUPER_ADMIN, prefers the
// selected-restaurant cookie set when the user picks a location. For ADMIN,
// reads the 'restaurant' field from the JWT.
export async function getRestaurantRef(): Promise<string | null> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) return null
  const payload = decodeJwt(token)
  const role = (payload?.role as string) || ''
  if (role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN') {
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
    if (selected) return selected
  }
  return (payload?.restaurant as string) || null
}

// For Middleware (Edge runtime — next/headers not available)
export function getRestaurantTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}
