import { NextRequest, NextResponse } from 'next/server'
import { validateDiscoRestaurantSession, DISCO_RESTAURANT_COOKIE } from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const token = req.cookies.get(DISCO_RESTAURANT_COOKIE)?.value
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const session = await validateDiscoRestaurantSession(token)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    return NextResponse.json(session)
  } catch (err) {
    console.error('[disco-restaurant-auth/me] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
}
