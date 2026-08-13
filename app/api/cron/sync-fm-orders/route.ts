// Cron: sync FM orders into Neon for restaurants whose portal is never opened.
//
// Runs hourly (vercel.json: "0 * * * *" — this comment previously claimed
// every 15 minutes; that was stale, fixed 2026-07-27). Restaurants only
// otherwise sync when someone opens their orders page, so quiet locations
// would drift. This rotates through the restaurant cache in bounded batches
// (a cursor in fm_orders_sync_cursor), so every restaurant is reconciled over
// a full cycle without any single run exceeding the function-duration limit.
//
// Incremental via stopAtKnownDate (lib/fm-orders-sync.ts): each restaurant's
// pull stops once it reaches order dates already covered by a prior sync,
// rather than always re-fetching only page 0 regardless of how much history
// exists — the fixed "only ever the ~100 most recent orders" ceiling that
// silently truncated every FM-backed restaurant's order history once it grew
// past that count (see the one-time fleet-wide backfill at
// app/api/admin/backfill-fm-history/route.ts, which corrected the existing
// gap; this is what stops the gap from recurring).
//
// reconcile:true adds the fix for stopAtKnownDate's own blind spot: it stops
// at known-covered dates, so it can never detect a hole INSIDE already-
// covered history (e.g. left behind by the old ceiling bug above, before
// stopAtKnownDate existed to prevent new ones). Each restaurant in the batch
// gets one cheap FM count check; on a mismatch this run's pull for that
// restaurant is upgraded to a full non-incremental pass. See
// syncAllRestaurantOrders in lib/fm-orders-sync.ts for the full design and
// cost (~one extra lightweight call per restaurant per batch visit).
//
// withItems:true — this run's work is incremental (stopAtKnownDate means most
// restaurants sync zero or a handful of new orders per hour), so the per-order
// detail fetch this adds is cheap here (measured ~250ms/order, ~4-5 new orders/
// hour fleet-wide) — unlike a full historical pull (see
// syncNonCacheRestaurantOrders, which stays withItems:false for exactly that
// reason). Without this, every order synced from here on would get a header
// with no transaction row, no items, no add-ons, forever — the same failure
// shape as the sync candidate-list bug: history gets repaired while the
// ongoing writer stays broken. syncAllRestaurantOrders also runs
// repairBareOrderDetail per restaurant regardless of this flag, closing the
// backlog that withItems:false pulls (this one's own mismatch branch, and
// syncNonCacheRestaurantOrders) still produce.
//
// REQUIRED ENV: CRON_SECRET — Vercel Cron sends it as `Authorization: Bearer …`.

import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { syncAllRestaurantOrders } from '../../../../lib/fm-orders-sync'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Tried 200 (syncAllRestaurantOrders's own cap) — measured 465,941ms (~7.8
// min) for a real 200-restaurant run, an order of magnitude past the 300s
// platform maxDuration and the ~200s "dial it back" threshold. The cost
// estimate that suggested 200 was safe didn't account for repairBareOrderDetail
// clearing a real, still-large backlog (up to 20 orders × ~250ms per restaurant
// that has one) — that cost shrinks as the backlog clears, but not fast enough
// to raise this today. Left at the original, proven-safe value; revisit once
// bareRepaired trends near zero across runs (see the log line below).
const BATCH = 50
const CURSOR_KEY = 'fm_orders_sync_offset'

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function readCursor(): Promise<number> {
  try {
    const rows = (await sql`SELECT offset_value FROM fm_orders_sync_cursor WHERE key = ${CURSOR_KEY}`) as { offset_value: number }[]
    const n = rows[0] ? Number(rows[0].offset_value) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch { return 0 }
}
async function writeCursor(offset: number): Promise<void> {
  // NOT best-effort-silent: a failed cursor write means the rotation never
  // advances (the bug this replaced). Surface it loudly if it ever fails again.
  try {
    await sql`
      INSERT INTO fm_orders_sync_cursor (key, offset_value, updated_at) VALUES (${CURSOR_KEY}, ${offset}, NOW())
      ON CONFLICT (key) DO UPDATE SET offset_value = ${offset}, updated_at = NOW()
    `
  } catch (e) {
    console.error('[cron/sync-fm-orders] CURSOR WRITE FAILED — rotation will stall:', e instanceof Error ? e.message : e)
    await alertOps(`FM orders sync cursor write failed (rotation stalled): ${e instanceof Error ? e.message : e}`)
  }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  try {
    await runMigrations()
    const offset = await readCursor()
    // maxPages is a safety ceiling, not the normal stopping point — with
    // stopAtKnownDate, a restaurant with nothing new since last sync stops
    // after page 0 as before; this only pages further when a restaurant has
    // genuinely accumulated more than a page's worth of orders since the last
    // hourly pass.
    const { restaurants, results, mismatches, bareRepairs } = await syncAllRestaurantOrders({ withItems: true, limit: BATCH, offset, maxPages: 10, stopAtKnownDate: true, reconcile: true })
    // Advance the cursor; wrap to 0 when this batch was the tail.
    await writeCursor(restaurants < BATCH ? 0 : offset + BATCH)

    const synced = results.reduce((a, r) => a + r.inserted + r.updated, 0)
    const bareRepaired = bareRepairs.reduce((a, r) => a + r.repaired, 0)
    const duration_ms = Date.now() - startedAt
    console.log(`[cron/sync-fm-orders] offset=${offset} restaurants=${restaurants} synced=${synced} mismatches=${mismatches.length} bareRepaired=${bareRepaired} (${duration_ms}ms)`)
    return NextResponse.json({ synced, restaurants, offset, mismatches, bareRepairs, duration_ms })
  } catch (e) {
    console.error('[cron/sync-fm-orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'sync failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
