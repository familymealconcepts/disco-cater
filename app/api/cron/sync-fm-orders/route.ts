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
import { syncAllRestaurantOrders, cleanupOrphanedDraftMirrors } from '../../../../lib/fm-orders-sync'
import { alertGroup, resolveAlert, openAlertKeys, noteJobFailure, noteJobSuccess, bumpStreaks, clearStreaks } from '../../../../lib/ops-alert'
import { shortError } from '../../../../lib/ops-alert-format'
import { restaurantName } from '../../../../lib/ops-alert-facts'
import { mirrorAlert, recordMirrorAlert } from '../../../../lib/mirror-alert'
import { resolveMissingOrderAlerts } from '../../../../lib/order/missing-order-alert'

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

// ── THE STALL ALARM ─────────────────────────────────────────────────────────
// This job runs hourly, so the cursor's updated_at should never be more than
// about an hour old. In October 2026 it sat unchanged for FIFTY-ONE HOURS and
// produced no signal anywhere: the run returned 500 before reaching any write,
// and a 500 from a cron is invisible unless somebody goes looking. The stall
// was found only because a human noticed one missing order.
//
// Three hours is deliberately loose — it tolerates two consecutive bad runs
// before it speaks, so a single transient failure doesn't page anyone, while a
// genuine stall surfaces the same morning instead of two days later.
const STALL_ALERT_HOURS = 3

async function alertIfCursorStalled(): Promise<void> {
  try {
    const rows = (await sql`
      SELECT offset_value, EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600 AS hours_stale
      FROM fm_orders_sync_cursor WHERE key = ${CURSOR_KEY}
    `) as { offset_value: number; hours_stale: string | number }[]
    if (!rows[0]) return
    const hours = Number(rows[0].hours_stale)
    if (!Number.isFinite(hours)) return
    if (hours < STALL_ALERT_HOURS) {
      // Moving again: close the thread, saying how long it was stuck.
      if ((await openAlertKeys('fm-mirror:stalled')).length) {
        const since = (await sql`
          SELECT EXTRACT(EPOCH FROM (NOW() - first_alerted_at)) / 3600 AS h FROM disco_alert_dedup WHERE alert_key = 'fm-mirror:stalled'
        `.catch(() => [])) as Array<{ h: string | number }>
        const stuck = Number(since[0]?.h) + STALL_ALERT_HOURS
        await resolveAlert('fm-mirror:stalled', `Resolved: the sync is moving again${Number.isFinite(stuck) ? ` (it was stuck about ${stuck.toFixed(1)} hours)` : ''}.`)
      }
      return
    }
    await mirrorAlert('cursor-stalled', {
      severity: 'urgent',
      headline: "FamilyMeal orders aren't reaching Disco",
      lines: [`The order sync hasn't moved in ${hours.toFixed(1)} hours, so new FamilyMeal orders for converted restaurants aren't showing up in their Disco portals.`],
      action: 'check the sync-fm-orders cron in Vercel.',
      context: { cursorOffset: rows[0].offset_value, hoursStale: Number(hours.toFixed(1)) },
    }, { key: 'fm-mirror:stalled' })
  } catch (e) {
    console.error('[cron/sync-fm-orders] stall check failed (non-fatal):', e instanceof Error ? e.message : e)
  }
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
    await noteJobFailure('sync-fm-orders:cursor', e)
    return
  }
  await noteJobSuccess('sync-fm-orders:cursor')
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  try {
    await runMigrations()
    // Before this run claims its step — so the alarm reflects how long the
    // mirror was actually stuck, not how long since this run started.
    await alertIfCursorStalled()
    const offset = await readCursor()

    // ── THE ROTATION MOVES BEFORE THE WORK, NOT ONLY AFTER IT ────────────────
    // Every other cursor write in this file happens AFTER at least one
    // restaurant has finished: onProgress fires per completed restaurant, and
    // the reconciling write below needs the function to return. Neither
    // survives the platform killing this function at maxDuration while the
    // FIRST restaurant of the batch is still running — and then the next hour
    // re-reads the same offset and dies in the same place, forever.
    //
    // That is not theoretical either. Offset 906 is Mav's Top Buns, which has a
    // reconciliation mismatch (neon 1195 vs FM 1200). A mismatch sets
    // stopAtKnownDate=false and maxPages=500, so the rotation re-pulls its whole
    // history with withItems — measured at roughly five minutes for its ~1,200
    // orders, against a 300s maxDuration. It can never finish, so it can never
    // report progress, so the cursor can never move past it.
    //
    // So claim one step up front. A killed run now costs at most the single
    // restaurant it died on, which the next full rotation picks up anyway,
    // instead of pinning the whole fleet behind it. A run that finishes
    // overwrites this with the real advance below.
    await writeCursor(offset + 1)

    // maxPages is a safety ceiling, not the normal stopping point — with
    // stopAtKnownDate, a restaurant with nothing new since last sync stops
    // after page 0 as before; this only pages further when a restaurant has
    // genuinely accumulated more than a page's worth of orders since the last
    // hourly pass.
    const { restaurants, processed, exhausted, budgetStopped, rowsRead, results, mismatches, bareRepairs, failures } =
      await syncAllRestaurantOrders({
        withItems: true, limit: BATCH, offset, maxPages: 10, stopAtKnownDate: true, reconcile: true,
        // Persist the cursor AS THE RUN PROGRESSES, not only at the end. The
        // time budget stops a run cleanly, but it is checked BETWEEN
        // restaurants and a single slow one can outlast the whole window — so
        // a budget alone still leaves a path where the platform kills the
        // function before the final write. Writing per restaurant means a kill
        // loses at most the one in flight, and the rotation always moves.
        onProgress: async (done) => { await writeCursor(offset + done) },
      })

    // ── THE CURSOR MUST ALWAYS MOVE ───────────────────────────────────────
    // This previously advanced by the full BATCH, which is only correct if the
    // whole batch finished — and it was reached only if the run finished at
    // all. When syncAllRestaurantOrders ran past maxDuration the platform
    // killed the function here, so the cursor was never written and the next
    // hour re-read the same offset and died identically. Measured frozen at
    // offset 900 for four and a half days (2026-10-01 → 2026-10-05), which is
    // how Maciel's FM order 34045722 went missing.
    //
    // So: advance by what was ACTUALLY processed, and never by zero. A batch
    // whose very first restaurant cannot finish inside the budget would
    // otherwise pin the rotation forever — the same failure in a smaller
    // window. Stepping past it costs that restaurant one rotation; the next
    // pass picks it up with its backlog already partly drained.
    // Advance by ROWS READ when the batch finished, so the six slug-reference
    // rows isUuid drops are stepped over rather than re-read every run; fall
    // back to `processed` when a budget stop cut the batch short.
    const advanceBy = budgetStopped ? Math.max(1, processed) : Math.max(1, rowsRead)
    await writeCursor(exhausted ? 0 : offset + advanceBy)

    // Global, not scoped to this run's restaurant batch — cheap enough to run
    // every hour regardless. Best-effort: a failure here must never fail the
    // main rotating sync above (the cursor write already happened).
    let orphansDeleted = 0
    try {
      orphansDeleted = (await cleanupOrphanedDraftMirrors()).deleted
    } catch (e) {
      console.error('[cron/sync-fm-orders] orphaned draft-mirror cleanup failed (non-fatal):', e instanceof Error ? e.message : e)
    }

    // A skipped restaurant is no longer fatal (lib/fm-orders-sync.ts guards each
    // one), which is exactly why it has to be announced: a run that silently
    // skips the same restaurant every hour looks identical to a healthy one on
    // the summary line. Name them, so "it's been failing for days" is not a
    // thing anyone has to discover by hand.
    // Per restaurant, after 2 failed runs in a row — one skip is a blip.
    const failedRefs = Array.from(new Set(failures.map(f => f.restaurantReference)))
    const streaks = await bumpStreaks('fm-sync:', failedRefs)
    const due = failures.filter(f => (streaks.get(f.restaurantReference) ?? 0) >= 2)
    if (due.length) {
      const named = await Promise.all(due.map(async f => ({
        ...f, key: `fm-sync-fail:${f.restaurantReference.toLowerCase()}`,
        name: (await restaurantName(f.restaurantReference)) ?? f.restaurantReference,
        runs: streaks.get(f.restaurantReference) ?? 2,
      })))
      const fresh = await alertGroup(named, items => ({
        severity: 'warn',
        headline: `FamilyMeal order sync failing for ${items.length} restaurant${items.length === 1 ? '' : 's'}`,
        lines: [`Skipped ${Math.min(...items.map(x => x.runs))} runs in a row: ${items.slice(0, 10).map(x => `${x.name} (${shortError(x.error, 60)})`).join(', ')}. Their new orders may not reach Disco.`],
        action: 'nothing if it clears next run; otherwise check the restaurant in FamilyMeal.',
        context: { failures: items.map(x => `${x.restaurantReference} [${x.stage}] ${x.error}`), offset },
      }))
      if (fresh.length) await recordMirrorAlert('restaurants-failed', `${fresh.length} restaurant(s) failing`, { refs: fresh.map(x => x.restaurantReference) })
    }
    const okRefs = results.filter(r => !r.error && !failedRefs.includes(r.restaurantReference)).map(r => r.restaurantReference)
    for (const ref of await clearStreaks('fm-sync:', okRefs)) {
      const name = (await restaurantName(ref)) ?? ref
      await resolveAlert(`fm-sync-fail:${ref.toLowerCase()}`, `${name} is syncing again.`)
    }
    await resolveMissingOrderAlerts().catch(() => {})
    await noteJobSuccess('sync-fm-orders')

    const synced = results.reduce((a, r) => a + r.inserted + r.updated, 0)
    const bareRepaired = bareRepairs.reduce((a, r) => a + r.repaired, 0)
    const duration_ms = Date.now() - startedAt
    console.log(`[cron/sync-fm-orders] offset=${offset} rowsRead=${rowsRead} restaurants=${restaurants} processed=${processed} budgetStopped=${budgetStopped} synced=${synced} mismatches=${mismatches.length} bareRepaired=${bareRepaired} failures=${failures.length} orphansDeleted=${orphansDeleted} (${duration_ms}ms)`)
    return NextResponse.json({ synced, restaurants, processed, exhausted, budgetStopped, offset, mismatches, bareRepairs, failures, orphansDeleted, duration_ms })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[cron/sync-fm-orders] failed:', error)
    // ALERT, don't just log. This catch used to return 500 silently, so an
    // hourly job that failed every run for four and a half days produced no
    // signal anywhere — the stall was found only because a human noticed one
    // missing order. A platform timeout kills the function outright and never
    // reaches here, which is exactly why the time budget above matters more
    // than this alert does; this covers every other failure mode.
    await noteJobFailure('sync-fm-orders', error)
    await recordMirrorAlert('run-failed', `sync-fm-orders FAILED: ${error}`, { error })
    return NextResponse.json({ error: 'sync failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
