import { NextRequest } from 'next/server'

export const RESTAURANT_TOKEN_COOKIE = 'fm_restaurant_token'
export const RESTAURANT_REFRESH_COOKIE = 'fm_restaurant_refresh'

export const RESTAURANT_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
}

export function getRestaurantToken(req: NextRequest): string | null {
  return req.cookies.get(RESTAURANT_TOKEN_COOKIE)?.value ?? null
}
