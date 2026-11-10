import { NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../lib/admin-auth'
import { logAdminAction } from '../../../../lib/admin-audit'
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
    // Who clicked Refresh Map Cache, and what it did (Peter, 2026-11-10). The nightly cron is not logged here.
    await logAdminAction({
      action: 'map_cache_refresh', restaurantReference: null, actorEmail: await getAdminEmail().catch(() => null),
      detail: { total: result.total, cached: result.cached, qualified: result.qualified, missing: result.missing, rejected: result.rejected, durationMs: result.durationMs },
    })
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[refresh-restaurant-cache] failed:', message, e instanceof Error ? e.stack : '')
    await logAdminAction({ action: 'map_cache_refresh', restaurantReference: null, actorEmail: await getAdminEmail().catch(() => null), detail: { error: message } })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
