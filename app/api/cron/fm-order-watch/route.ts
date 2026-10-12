// Cron: keep every CONVERTED restaurant's FamilyMeal orders no more than ~30
// minutes behind Disco. Runs every 30 minutes (vercel.json).
//
// ── WHY A SEPARATE JOB ──────────────────────────────────────────────────────
// The hourly rotation in cron/sync-fm-orders walks all 4,256 cached restaurants
// 50 at a time — a 3.5-day round trip — and its converted-restaurant sweep
// covers 60 of ~398 per run, so a new FamilyMeal order at a converted
// restaurant could wait 8-22 hours to appear. Rooted Cafe & Catering's $958.23
// order waited two days. That rotation is the right shape for deep history
// repair and the wrong shape for freshness, so freshness gets its own job.
//
// ── WHY IT IS AFFORDABLE ────────────────────────────────────────────────────
// Measured in production, not estimated:
//
//   • the count call (`size=1`, returns totalElements) over all 398 converted
//     restaurants: p50 219ms, p90 526ms, mean 292ms, 112.5s serial —
//     31.0s wall-clock at concurrency 4.
//   • new FM orders at converted restaurants: 7-21 per DAY, and per active hour
//     an average of 1.4 orders across 1.26 restaurants, max 6 across 3. Only 99
//     of the last 336 hours had any FM order at all.
//
// So the expensive part — actually pulling orders — is needed for roughly zero
// to three restaurants an hour. Checking everyone is cheap; fetching from
// everyone is not. Hence two passes.
//
// ── THE PART THAT MAKES IT WORK: known_gap ──────────────────────────────────
// "Fetch wherever FamilyMeal's count exceeds Neon's" is the obvious rule and it
// does not survive contact with the data. The production gap run found 22
// restaurants with FM > Neon and exactly ONE with a real missing order. The
// other 21 differ permanently: FamilyMeal counts carts, and EXPIRED/CANCELED
// rows with a null customer email, which Neon structurally cannot store
// (disco_orders.customer_email is NOT NULL, so upsertOne skips them). Re-pulling
// those 21 every run would cost up to 37s each — ~777s against a 300s ceiling —
// forever, and find nothing every time.
//
// So each restaurant carries a known_gap baseline in disco_fm_sync_watch, and a
// fetch is triggered only when the gap GROWS beyond it. After a fetch, whatever
// gap remains becomes the new baseline. Steady state: 398 cheap calls, zero
// fetches, no FamilyMeal load beyond the counts.
//
// ── LOAD ON FAMILYMEAL ──────────────────────────────────────────────────────
// Deliberately gentle, because FamilyMeal still serves its own customers. The
// count call is the lightest request the API has, ONE request per restaurant
// (see fmCount — the public-api shape was dropped after production showed it
// 404ing for every restaurant, which had been doubling the request count for
// nothing). Concurrency is 3, so at most three lightweight reads are ever in
// flight. At 30-minute cadence that is ~796 count calls an hour.
//
// In exchange CONVERTED_CAP in the rotation's own sweep drops from 60 to 20,
// removing ~40 of the much heavier per-restaurant page pulls an hour. Lighter
// in bytes and query weight than before, an order of magnitude fresher.
//
// REQUIRED ENV: CRON_SECRET.

import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { mirrorAlert } from '../../../../lib/mirror-alert'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { fmFetch } from '../../../../lib/fm-fetch'
import { syncRestaurantOrders } from '../../../../lib/fm-orders-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

/** At most three lightweight FamilyMeal reads in flight at once. 31.0s measured
 *  at 4; 3 trades a few seconds of wall clock for a gentler footprint. */
const COUNT_CONCURRENCY = 3
/** Leaves ~60s of headroom under maxDuration for the fetch pass to finish the
 *  restaurant it is on and for the bookkeeping writes below. */
const TIME_BUDGET_MS = 230_000
/** Fetch pass ceiling. Three a run is already double the measured hourly
 *  maximum; anything beyond is left for the next run 30 minutes later and for
 *  the daily gap check, rather than risking the window. */
const FETCH_CAP = 8
/** Staleness alarm. The goal is every converted restaurant inside an hour; at a
 *  30-minute cadence, 2 hours means four consecutive misses before it speaks. */
const STALE_ALERT_HOURS = 2

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

/**
 * The count call, with the two outcomes kept apart.
 *
 * ONLY the admin endpoint is called. The mirror tries `public-api/v2` first and
 * falls back, so this did too — until the first production run showed that
 * endpoint returning 404 for EVERY restaurant, healthy or not (sampled across
 * both working and failing ones). It was never answering; it was just doubling
 * the request count against FamilyMeal and adding ~110ms to every check.
 *
 * 'absent' vs 'error' matters for the staleness alarm. A 404 from the admin
 * endpoint is a definitive answer — FamilyMeal does not have this restaurant —
 * and six converted restaurants are permanently in that state (Almost Home,
 * Cafe Gia, Cena Vegan and three more). Treating that as a failed check would
 * mean alerting about them every 30 minutes forever, which is how an alert
 * channel gets muted. They count as checked. A timeout or 5xx is a genuine
 * no-answer and does not.
 */
type CountResult =
  | { state: 'ok'; total: number }
  | { state: 'absent' }
  | { state: 'error' }

async function fmCount(ref: string, auth: Record<string, string>): Promise<CountResult> {
  const url = `${FM}/api/admin/restaurants/${ref}/orders?page=0&size=1`
  // Two attempts. The first run saw 32 of 398 fail, and re-probing them by hand
  // minutes later found almost all answering 200 — transient, not broken. One
  // cheap retry converts that into a non-event instead of a false alarm.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fmFetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' }, 30_000)
      if (res.status === 404) return { state: 'absent' }
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (j && typeof j.totalElements === 'number') return { state: 'ok', total: j.totalElements as number }
      }
    } catch { /* fall through to the retry */ }
    if (attempt === 1) await new Promise(r => setTimeout(r, 300))
  }
  return { state: 'error' }
}

async function neonCountFor(ref: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_orders
    WHERE restaurant_reference::text = ${ref}
      AND fm_order_reference IS NOT NULL AND is_deleted = false
  `.catch(() => [])) as { n: number }[]
  return rows[0]?.n ?? 0
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  const deadline = startedAt + TIME_BUDGET_MS
  try {
    await runMigrations()

    const rows = (await sql`
      SELECT DISTINCT c.restaurant_reference::text AS ref
      FROM disco_restaurant_cache c
      JOIN disco_orders o ON o.restaurant_reference::text = c.restaurant_reference::text
      WHERE c.is_disco_native = true
        AND o.source_of_order = 'FAMILYMEAL'
        AND o.is_deleted = false
    `.catch(() => [])) as { ref: string }[]
    const targets = rows.map(r => r.ref).filter(isUuid)

    const auth = await getFmServiceAuthHeader()

    // ── PASS 1: one cheap count per restaurant ───────────────────────────────
    const baseline = (await sql`
      SELECT restaurant_reference::text AS ref, known_gap FROM disco_fm_sync_watch
    `.catch(() => [])) as { ref: string; known_gap: number }[]
    const knownGap = new Map(baseline.map(b => [b.ref, Number(b.known_gap) || 0]))

    const needsFetch: { ref: string; fmTotal: number; neonCount: number; gap: number; was: number }[] = []
    let checked = 0
    let countErrors = 0
    let absent = 0
    let i = 0

    const worker = async () => {
      for (;;) {
        const k = i++
        if (k >= targets.length || Date.now() > deadline) return
        const ref = targets[k]
        const res = await fmCount(ref, auth)
        if (res.state === 'error') {
          countErrors++
          await sql`
            INSERT INTO disco_fm_sync_watch (restaurant_reference, consecutive_errors, updated_at)
            VALUES (${ref}::uuid, 1, NOW())
            ON CONFLICT (restaurant_reference) DO UPDATE
              SET consecutive_errors = disco_fm_sync_watch.consecutive_errors + 1, updated_at = NOW()
          `.catch(() => {})
          continue
        }
        if (res.state === 'absent') {
          // FamilyMeal answered, and the answer is "no such restaurant". That is
          // a completed check — it just has nothing to mirror, now or ever.
          absent++
          await sql`
            INSERT INTO disco_fm_sync_watch (restaurant_reference, last_checked_at, consecutive_errors, updated_at)
            VALUES (${ref}::uuid, NOW(), 0, NOW())
            ON CONFLICT (restaurant_reference) DO UPDATE
              SET last_checked_at = NOW(), consecutive_errors = 0, updated_at = NOW()
          `.catch(() => {})
          continue
        }
        const fmTotal = res.total
        const neonCount = await neonCountFor(ref)
        const gap = fmTotal - neonCount
        const was = knownGap.get(ref) ?? 0
        checked++
        // last_checked_at is written for EVERY successful check, fetch or not —
        // it answers "is this restaurant being watched", not "did it change".
        await sql`
          INSERT INTO disco_fm_sync_watch (restaurant_reference, last_checked_at, last_fm_total, last_neon_count, known_gap, consecutive_errors, updated_at)
          VALUES (${ref}::uuid, NOW(), ${fmTotal}, ${neonCount}, ${Math.max(0, Math.min(gap, was))}, 0, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE
            SET last_checked_at = NOW(), last_fm_total = ${fmTotal}, last_neon_count = ${neonCount},
                consecutive_errors = 0, updated_at = NOW()
        `.catch(() => {})
        // Only a gap LARGER than this restaurant's permanent baseline is news.
        if (gap > was) needsFetch.push({ ref, fmTotal, neonCount, gap, was })
      }
    }
    await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, () => worker()))
    const pass1Ms = Date.now() - startedAt

    // ── PASS 2: pull orders, only where the gap grew ─────────────────────────
    // Sorted newest-first by fetchFmOrdersPage, so one page covers up to 50 new
    // orders — far beyond the measured maximum of 6 in any hour.
    const fetched: { ref: string; inserted: number; updated: number; residualGap: number; ms: number }[] = []
    const failures: { ref: string; error: string }[] = []
    for (const n of needsFetch.slice(0, FETCH_CAP)) {
      if (Date.now() > deadline) break
      const t0 = Date.now()
      try {
        const out = await syncRestaurantOrders(n.ref, { withItems: true, pageSize: 50, maxPages: 2, stopAtKnownDate: true })
        const after = await neonCountFor(n.ref)
        // Whatever is still missing after a real pull is unmirrorable — carts,
        // or rows with no customer email. Record it so this restaurant stops
        // asking to be fetched until something genuinely new arrives.
        const residual = Math.max(0, n.fmTotal - after)
        await sql`
          UPDATE disco_fm_sync_watch
          SET known_gap = ${residual}, last_neon_count = ${after}, last_synced_at = NOW(), updated_at = NOW()
          WHERE restaurant_reference = ${n.ref}::uuid
        `.catch(() => {})
        fetched.push({ ref: n.ref, inserted: out.inserted, updated: out.updated, residualGap: residual, ms: Date.now() - t0 })
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        console.error(`[cron/fm-order-watch] fetch failed for ${n.ref} — skipped, run continues: ${error}`)
        failures.push({ ref: n.ref, error })
      }
    }

    // ── STALENESS ALARM ──────────────────────────────────────────────────────
    // Reads the table rather than this run's own bookkeeping, so a restaurant
    // that silently stopped being visited is caught even if this run looked
    // healthy. A row that has never been checked counts as stale.
    const stale = (await sql`
      SELECT c.restaurant_reference::text AS ref, c.name,
             EXTRACT(EPOCH FROM (NOW() - w.last_checked_at)) / 3600 AS hours
      FROM disco_restaurant_cache c
      JOIN disco_orders o ON o.restaurant_reference::text = c.restaurant_reference::text
      LEFT JOIN disco_fm_sync_watch w ON w.restaurant_reference::text = c.restaurant_reference::text
      WHERE c.is_disco_native = true AND o.source_of_order = 'FAMILYMEAL' AND o.is_deleted = false
      GROUP BY 1, 2, 3
      HAVING w.last_checked_at IS NULL
          OR EXTRACT(EPOCH FROM (NOW() - w.last_checked_at)) / 3600 >= ${STALE_ALERT_HOURS}
      ORDER BY 3 DESC NULLS FIRST
      LIMIT 50
    `.catch(() => [])) as { ref: string; name: string | null; hours: string | null }[]

    // Never on the very first run, when every row is legitimately unseen.
    const firstRun = baseline.length === 0
    if (stale.length && !firstRun) {
      await mirrorAlert(
        'watch-stale',
        `FM order watch: ${stale.length} converted restaurant(s) not checked in ${STALE_ALERT_HOURS}+ hours`,
        {
          restaurants: stale.slice(0, 25).map(s => `${s.name || s.ref} (${s.hours == null ? 'never checked' : Number(s.hours).toFixed(1) + 'h ago'})`),
          truncated: stale.length > 25 ? stale.length - 25 : 0,
        },
      )
    }

    if (failures.length) {
      await mirrorAlert(
        'watch-fetch-failed',
        `FM order watch: ${failures.length} restaurant(s) failed their order fetch`,
        { failures: failures.slice(0, 20).map(f => `${f.ref}: ${f.error}`) },
      )
    }

    const inserted = fetched.reduce((a, f) => a + f.inserted, 0)
    const duration_ms = Date.now() - startedAt
    console.log(`[cron/fm-order-watch] converted=${targets.length} checked=${checked} absent=${absent} countErrors=${countErrors} pass1Ms=${pass1Ms} needsFetch=${needsFetch.length} fetched=${fetched.length} inserted=${inserted} failures=${failures.length} stale=${stale.length} (${duration_ms}ms)`)
    return NextResponse.json({
      converted: targets.length, checked, absent, countErrors, pass1Ms,
      needsFetch: needsFetch.length, fetched, inserted,
      failures, stale: stale.length, firstRun, duration_ms,
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[cron/fm-order-watch] failed:', error)
    await mirrorAlert('run-failed', `fm-order-watch FAILED (converted restaurants are unwatched): ${error}`, { error })
    return NextResponse.json({ error: 'watch failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
