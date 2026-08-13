// Cron: sync FM order history for restaurants disco_restaurant_cache's own
// normalize() excludes from LIVE/marketplace visibility (blocked, or missing
// address coordinates — lib/restaurant-cache.ts:75).
//
// The regular hourly cron (app/api/cron/sync-fm-orders/route.ts) discovers its
// restaurant candidates FROM disco_restaurant_cache, so a blocked restaurant's
// entire order history was permanently invisible to it — not a rotation-speed
// problem, a candidate-list problem. This is a separate, cache-independent
// path: it fetches FM's live restaurant list directly (reusing restaurant-
// cache.ts's own pagination), filters to references not already in the cache,
// and pulls each one's full history, re-attempting on a later run if a prior
// one left it partial (see syncNonCacheRestaurantOrders in
// lib/fm-orders-sync.ts for the full reasoning, including why there's no new
// progress-marker column).
//
// Daily, not hourly — this population is small (currently ~57 restaurants)
// and static (blocked restaurants aren't taking new orders), so there's no
// freshness requirement pushing toward hourly.
//
// REQUIRED ENV: CRON_SECRET — Vercel Cron sends it as `Authorization: Bearer …`.

import { NextRequest, NextResponse } from 'next/server'
import { runMigrations } from '../../../../lib/db'
import { syncNonCacheRestaurantOrders } from '../../../../lib/fm-orders-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  try {
    await runMigrations()
    const result = await syncNonCacheRestaurantOrders()
    const synced = result.results.reduce((a, r) => a + r.inserted + r.updated, 0)
    const duration_ms = Date.now() - startedAt
    console.log(`[cron/sync-fm-orders-noncache] fmRestaurants=${result.fmRestaurants} notInCache=${result.notInCache} alreadyComplete=${result.alreadyComplete} resumedPartial=${result.resumedPartial} attempted=${result.attempted} countCheckFailed=${result.countCheckFailed} synced=${synced} (${duration_ms}ms)`)
    return NextResponse.json({ ...result, synced, duration_ms })
  } catch (e) {
    console.error('[cron/sync-fm-orders-noncache] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'sync failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
