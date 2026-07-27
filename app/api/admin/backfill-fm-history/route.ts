import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql, runFmHistoryBackfillMigrations } from '../../../../lib/db'
import { backfillFmOrderHistory } from '../../../../lib/native-conversion'

// One-time fleet-wide FM order-history backfill (super-admin only).
//
// The hourly sync-fm-orders cron only ever pulls each restaurant's ~100 most
// recent orders (page 0, no date cursor — see that route), so any FM-backed
// restaurant with more lifetime orders than that has silently truncated
// history in Neon everywhere it's read for reporting (Live Partners, etc).
// backfillFmOrderHistory (lib/native-conversion.ts) already pulls a
// restaurant's COMPLETE FM history and is decoupled from convertToNative's
// conversion-specific side effects (no Stripe checks, no is_disco_native
// flip) — this route just points it at every FM-backed restaurant, not only
// native-conversion candidates, batched rather than attempted in one shot.
//
// Progress is tracked via disco_restaurant_cache.fm_history_backfilled_at (a
// NULL-flag "cursor" — resumable from any point, self-documenting via a plain
// query) rather than a numeric offset, since this is a run-until-complete
// one-time job, not a perpetually-rotating cron.
//
//   GET  → progress summary (eligible / done / pending / failed counts + the
//          failed restaurants' recorded errors — never silently skipped)
//   POST → process one batch. Body: { batchSize?: number, restaurantReferences?: string[] }
//          Explicit restaurantReferences bypasses the "not yet done" filter
//          (used for the dry-run / manual-retry case); omit it to pull the
//          next batchSize pending restaurants automatically.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface EligibleRow { restaurant_reference: string; name: string | null }

async function eligibleCounts() {
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE fm_history_backfilled_at IS NOT NULL)::int AS done,
      COUNT(*) FILTER (WHERE fm_history_backfilled_at IS NULL AND fm_history_backfill_error IS NOT NULL)::int AS failed,
      COUNT(*) FILTER (WHERE fm_history_backfilled_at IS NULL AND fm_history_backfill_error IS NULL)::int AS pending,
      COUNT(*)::int AS total
    FROM disco_restaurant_cache rc
    WHERE COALESCE(rc.is_disco_native, false) = false
      AND rc.restaurant_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND EXISTS (SELECT 1 FROM disco_orders o WHERE o.restaurant_reference = rc.restaurant_reference::uuid AND o.is_deleted = false)
  `) as { done: number; failed: number; pending: number; total: number }[]
  return rows[0]
}

export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  await runFmHistoryBackfillMigrations()
  const counts = await eligibleCounts()
  const failedRows = (await sql`
    SELECT restaurant_reference, name, fm_history_backfill_error
    FROM disco_restaurant_cache
    WHERE fm_history_backfilled_at IS NULL AND fm_history_backfill_error IS NOT NULL
    ORDER BY name
  `) as { restaurant_reference: string; name: string | null; fm_history_backfill_error: string }[]
  return NextResponse.json({ ...counts, failedRestaurants: failedRows })
}

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  await runFmHistoryBackfillMigrations()

  let body: { batchSize?: number; restaurantReferences?: string[] }
  try { body = await req.json() } catch { body = {} }

  let targets: EligibleRow[]
  if (Array.isArray(body.restaurantReferences) && body.restaurantReferences.length) {
    const refs = body.restaurantReferences.filter((r) => UUID_RE.test(r))
    targets = (await sql`
      SELECT restaurant_reference, name FROM disco_restaurant_cache
      WHERE restaurant_reference = ANY(${refs}) AND COALESCE(is_disco_native, false) = false
    `) as EligibleRow[]
  } else {
    const batchSize = Math.min(Math.max(body.batchSize ?? 5, 1), 25)
    targets = (await sql`
      SELECT rc.restaurant_reference, rc.name
      FROM disco_restaurant_cache rc
      WHERE COALESCE(rc.is_disco_native, false) = false
        AND rc.restaurant_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND rc.fm_history_backfilled_at IS NULL
        AND EXISTS (SELECT 1 FROM disco_orders o WHERE o.restaurant_reference = rc.restaurant_reference::uuid AND o.is_deleted = false)
      ORDER BY rc.restaurant_reference
      LIMIT ${batchSize}
    `) as EligibleRow[]
  }

  const batch: {
    restaurantReference: string; name: string | null; ok: boolean
    fetched?: number; inserted?: number; updated?: number; skipped?: number; error?: string
  }[] = []

  // Sequential, not Promise.all — one restaurant's full history pull at a time
  // (up to 500 pages each), same reasoning as every other sequential Neon-client
  // usage in this codebase: predictable, bounded, and doesn't need FM-side
  // concurrency the service JWT wasn't built to handle.
  for (const t of targets) {
    const ref = t.restaurant_reference
    try {
      const result = await backfillFmOrderHistory(ref)
      if (result.ok) {
        await sql`UPDATE disco_restaurant_cache SET fm_history_backfilled_at = NOW(), fm_history_backfill_error = NULL WHERE restaurant_reference = ${ref}`
        batch.push({
          restaurantReference: ref, name: t.name, ok: true,
          fetched: result.fetched, inserted: result.inserted, updated: result.updated, skipped: result.skipped,
        })
      } else {
        await sql`UPDATE disco_restaurant_cache SET fm_history_backfill_error = ${result.error || 'unknown error'} WHERE restaurant_reference = ${ref}`
        batch.push({ restaurantReference: ref, name: t.name, ok: false, error: result.error })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      await sql`UPDATE disco_restaurant_cache SET fm_history_backfill_error = ${message} WHERE restaurant_reference = ${ref}`.catch(() => {})
      batch.push({ restaurantReference: ref, name: t.name, ok: false, error: message })
    }
  }

  const counts = await eligibleCounts()
  return NextResponse.json({ batch, ...counts })
}
