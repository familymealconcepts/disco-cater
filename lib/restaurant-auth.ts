import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'

export const RESTAURANT_TOKEN_COOKIE = 'fm_restaurant_token'
export const RESTAURANT_REFRESH_COOKIE = 'fm_restaurant_refresh'

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
export async function getRestaurantAuthHeader(): Promise<Record<string, string>> {
  const store = await cookies()
  const token = store.get(RESTAURANT_TOKEN_COOKIE)?.value
  if (!token) throw new Error('Not authenticated')
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

// For Middleware (Edge runtime — next/headers not available)
export function getRestaurantTokenFromRequest(req: NextRequest): string | null {
  return req.cookies.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}
