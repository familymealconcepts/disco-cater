import { NextRequest, NextResponse } from 'next/server'
import {
  deleteDiscoRestaurantSession,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const token = req.cookies.get(DISCO_RESTAURANT_COOKIE)?.value
  if (token) {
    try {
      await deleteDiscoRestaurantSession(token)
    } catch (err) {
      console.error('[disco-restaurant-auth/logout] failed:', err instanceof Error ? err.message : err)
    }
  }
  const res = NextResponse.json({ success: true })
  res.cookies.set(DISCO_RESTAURANT_COOKIE, '', { ...DISCO_RESTAURANT_COOKIE_OPTS, maxAge: 0 })
  return res
}
