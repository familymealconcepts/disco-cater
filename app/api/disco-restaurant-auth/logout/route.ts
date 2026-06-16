import { NextRequest, NextResponse } from 'next/server'
import {
  deleteDiscoRestaurantSession,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'
import {
  RESTAURANT_TOKEN_COOKIE,
  RESTAURANT_REFRESH_COOKIE,
  RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/restaurant-auth'

export const runtime = 'nodejs'

// Single restaurant-portal logout. The portal runs two auth paths in parallel
// (Disco-native `disco_restaurant_token` + Neon session, and legacy FM
// `fm_restaurant_token`), and middleware admits the portal if EITHER cookie is
// present — so logout must delete the Neon session AND clear BOTH cookie sets,
// regardless of which path the user signed in through.
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
  // Disco-native cookie.
  res.cookies.set(DISCO_RESTAURANT_COOKIE, '', { ...DISCO_RESTAURANT_COOKIE_OPTS, maxAge: 0 })
  // Legacy FM cookies (covers FM-authed restaurant users).
  res.cookies.set(RESTAURANT_TOKEN_COOKIE, '', { ...RESTAURANT_COOKIE_OPTS, maxAge: 0 })
  res.cookies.set(RESTAURANT_REFRESH_COOKIE, '', { ...RESTAURANT_COOKIE_OPTS, maxAge: 0 })
  return res
}
