import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { getRestaurantRole } from '../../../../../lib/restaurant-auth'
import { runDiscoOrderMigrations } from '../../../../../lib/db'
import { syncRestaurantOrders, syncAllRestaurantOrders } from '../../../../../lib/fm-orders-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// POST /api/admin/sync/fm-orders
// Pulls FM orders into Neon (disco_orders). FM is read-only; this is the only
// path that writes FM order data into Neon for the portal.
//   Body: { restaurantReference?, withItems?, allRestaurants?, limit?, offset?, maxPages? }
//   • restaurantReference → sync that one restaurant (withItems defaults true).
//   • allRestaurants:true (or no restaurantReference) → batch-sync from the cache.
// Auth: SUPER_ADMIN (admin OR restaurant session), or a CRON_SECRET bearer token
// so a Vercel cron can call it.
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

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* allow empty body */ }

  try {
    await runDiscoOrderMigrations()
  } catch (e) {
    console.error('[sync/fm-orders] migration warning:', e instanceof Error ? e.message : e)
  }

  const restaurantReference = String(body.restaurantReference || '').trim()
  const withItems = body.withItems !== false // default true
  const maxPages = typeof body.maxPages === 'number' ? body.maxPages : undefined

  try {
    if (restaurantReference) {
      const result = await syncRestaurantOrders(restaurantReference, { withItems, maxPages })
      return NextResponse.json({ ok: !result.error, result })
    }

    // Batch (all restaurants from the cache).
    const limit = typeof body.limit === 'number' ? body.limit : undefined
    const offset = typeof body.offset === 'number' ? body.offset : undefined
    const summary = await syncAllRestaurantOrders({ withItems: body.withItems === true, limit, offset, maxPages })
    const totals = summary.results.reduce(
      (a, r) => ({ fetched: a.fetched + r.fetched, inserted: a.inserted + r.inserted, updated: a.updated + r.updated, skipped: a.skipped + r.skipped }),
      { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
    )
    return NextResponse.json({ ok: true, restaurants: summary.restaurants, totals, results: summary.results })
  } catch (e) {
    console.error('[sync/fm-orders] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Sync failed', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
