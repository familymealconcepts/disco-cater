import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { refreshRestaurantCache } from '../../../../lib/restaurant-cache'

// Rebuilds disco_restaurant_cache from FM (active + coords restaurants), so the
// public /api/restaurants reads Neon only. Admin-cookie gated.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    const result = await refreshRestaurantCache()
    console.log(`[refresh-restaurant-cache] cached ${result.cached}/${result.total} in ${result.durationMs}ms`)
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[refresh-restaurant-cache] failed:', message, e instanceof Error ? e.stack : '')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
