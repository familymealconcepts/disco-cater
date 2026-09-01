import { NextRequest, NextResponse } from 'next/server'
import { validateDiscoRestaurantSession, countLocationAccess, DISCO_RESTAURANT_COOKIE } from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const token = req.cookies.get(DISCO_RESTAURANT_COOKIE)?.value
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const session = await validateDiscoRestaurantSession(token)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // How many locations this person can REACH. The portal shell needs it to
    // decide whether to render the multi-location UI, which must follow the
    // grant table rather than the role on the account row — see the
    // "Who can see which restaurants" section in CLAUDE.md.
    const locationAccessCount = await countLocationAccess(session.email)
    return NextResponse.json({ ...session, locationAccessCount })
  } catch (err) {
    console.error('[disco-restaurant-auth/me] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
}
