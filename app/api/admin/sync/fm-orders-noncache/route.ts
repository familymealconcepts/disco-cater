import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { getRestaurantRole } from '../../../../../lib/restaurant-auth'
import { runDiscoOrderMigrations } from '../../../../../lib/db'
import { syncNonCacheRestaurantOrders } from '../../../../../lib/fm-orders-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/admin/sync/fm-orders-noncache
//
// Syncs FM order history for restaurants disco_restaurant_cache's own
// normalize() excludes from LIVE/marketplace visibility (blocked, or missing
// address coordinates — lib/restaurant-cache.ts:75) — see
// syncNonCacheRestaurantOrders (lib/fm-orders-sync.ts) for the full reasoning.
// Cache-independent: discovers candidates from FM's live restaurant list
// directly, never touches disco_restaurant_cache's schema or population.
//
// Small, bounded population (currently ~57 restaurants) — daily cadence is
// enough; these restaurants aren't taking new orders. Auth: SUPER_ADMIN
// (admin OR restaurant session), or a CRON_SECRET bearer token for the daily
// Vercel cron.
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const isCron = !!cronSecret && bearer === cronSecret

  if (!isCron) {
    const [adminRole, restaurantRole] = await Promise.all([
      getAdminRole().catch(() => ''),
      getRestaurantRole().catch(() => ''),
    ])
    if (adminRole !== 'SUPER_ADMIN' && restaurantRole !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  try {
    await runDiscoOrderMigrations()
    const result = await syncNonCacheRestaurantOrders()
    const synced = result.results.reduce((a, r) => a + r.inserted + r.updated, 0)
    return NextResponse.json({ ...result, synced })
  } catch (e) {
    console.error('[admin/sync/fm-orders-noncache] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'sync failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return POST(req) }
