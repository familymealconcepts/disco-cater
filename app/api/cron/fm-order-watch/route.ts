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
import { isKnownFmDuplicateOrderNumber } from '../../../../lib/known-fm-order-duplicates'

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
type FmOrderBrief = {
  reference: string
  orderNumber: string
  orderStatus: string
  hasEmail: boolean
}

type CountResult =
  | { state: 'ok'; total: number; recent: FmOrderBrief[] }
  | { state: 'absent' }
  | { state: 'error' }

/**
 * How many of the newest orders to read back on every check.
 *
 * ── WHY THIS IS NOT size=1 ANY MORE ─────────────────────────────────────────
 * The old call asked only for totalElements and compared counts. Counts are
 * blind to substitution: Local Smoke BBQ showed FM 453 = Neon 453, gap zero,
 * while order #23186878 ($367.30, for the next day) was genuinely missing —
 * FamilyMeal had stopped counting something else at the same moment. A count
 * can only ever say "how many", never "which".
 *
 * Reading the newest five by order date gives totalElements AND the identity of
 * the recent orders in the SAME request, so a missing one is caught whatever
 * the counts say.
 *
 * COST, MEASURED AGAINST PRODUCTION FM before choosing (40-restaurant sample):
 *     size=1   p50 139ms  mean 168ms  -> ~22s for all 399 at concurrency 3
 *     size=5   p50 438ms  mean 422ms  -> ~56s for all 399 at concurrency 3
 *     size=10  p50 562ms  mean 635ms  -> ~84s
 *     size=25  p50 1105ms mean 1315ms -> ~175s
 *
 * Five is the smallest window that cannot realistically miss an arrival: the
 * measured fleet-wide maximum is 6 new orders in an HOUR across every converted
 * restaurant, and this runs every 30 minutes, so five at a SINGLE restaurant is
 * far beyond anything observed. 56s leaves the 300s ceiling untouched.
 *
 * FamilyMeal's request count is UNCHANGED — still exactly one per restaurant
 * per cycle. The expensive half of that query is the COUNT behind
 * totalElements, which is identical; returning 5 rows instead of 1 is
 * negligible server-side.
 */
const RECENT_WINDOW = 5

/** Statuses FamilyMeal counts and Neon deliberately never stores. */
const NON_ORDER = new Set(['CART', 'SELECTED'])

/**
 * Can this FamilyMeal row ever become a Disco order? Decided from the row AS IT
 * IS RIGHT NOW, never from stored state.
 *
 * Three shapes can never mirror, and each is a fact about the row rather than a
 * guess:
 *   - CART / SELECTED: a basket FamilyMeal counts and Neon deliberately omits.
 *   - no customer email: disco_orders.customer_email is NOT NULL, so the insert
 *     is refused by the schema. This is the same test the daily gap check makes
 *     (`if (!o.email) unmirrorable++`), and it is status-blind on purpose.
 *     #92117192 at Local Smoke BBQ is RESERVED, not EXPIRED, with a null email,
 *     null name and null total: an abandoned reservation FM never attached a
 *     customer to. Reading only EXPIRED/CANCELED missed it.
 *   - a known duplicate order number: Neon's key is (restaurant, orderNumber),
 *     so the second row has nowhere to go.
 *
 * -- WHY THIS IS RE-DECIDED EVERY CYCLE INSTEAD OF REMEMBERED ----------------
 * Because all three are states, not identities. A CART becomes an order when
 * somebody checks out; a RESERVED row with no email gains one at payment, and
 * it keeps the SAME reference when it does. Remembering "this reference is not
 * mirrorable" would therefore re-create the exact bug this file was rewritten
 * to kill, with a reference in place of a count. So the named check asks FM
 * afresh on every pass, and baseline_refs is left to the count rule alone,
 * where being stale is harmless because the named rule catches the real orders.
 */
function nonMirrorable(ref: string, o: { orderStatus: string; orderNumber: string; hasEmail: boolean }): boolean {
  return NON_ORDER.has(o.orderStatus) || !o.hasEmail || isKnownFmDuplicateOrderNumber(ref, o.orderNumber)
}

/** One full page of a restaurant's newest orders, for the post-fetch classification. */
async function fmGet(path: string, auth: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fmFetch(`${FM}/api/admin/${path}`, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' }, 30_000)
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch { return null }
}

async function fmCount(ref: string, auth: Record<string, string>): Promise<CountResult> {
  const url = `${FM}/api/admin/restaurants/${ref}/orders?page=0&size=${RECENT_WINDOW}&sort=orderDate,desc`
  // Two attempts. The first run saw 32 of 398 fail, and re-probing them by hand
  // minutes later found almost all answering 200 — transient, not broken. One
  // cheap retry converts that into a non-event instead of a false alarm.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fmFetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' }, 30_000)
      if (res.status === 404) return { state: 'absent' }
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (j && typeof j.totalElements === 'number') {
          const items = (j.content as Record<string, unknown>[] | undefined) ?? []
          const recent: FmOrderBrief[] = items.map(o => ({
            reference: String(o.reference ?? ''),
            orderNumber: String(o.orderNumber ?? ''),
            orderStatus: String(o.orderStatus ?? '').toUpperCase(),
            hasEmail: !!o.email,
          })).filter(o => o.reference)
          return { state: 'ok', total: j.totalElements as number, recent }
        }
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
      SELECT restaurant_reference::text AS ref, known_gap, baseline_refs FROM disco_fm_sync_watch
    `.catch(() => [])) as { ref: string; known_gap: number; baseline_refs: unknown }[]
    const knownGap = new Map(baseline.map(b => [b.ref, Number(b.known_gap) || 0]))
    // The set of references already CONFIRMED non-mirrorable for each restaurant.
    const baselineRefs = new Map<string, Set<string>>(
      baseline.map(b => [b.ref, new Set(Array.isArray(b.baseline_refs) ? (b.baseline_refs as string[]).map(String) : [])]),
    )

    const needsFetch: { ref: string; fmTotal: number; neonCount: number; gap: number; was: number; reason: string }[] = []
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
        const base = baselineRefs.get(ref) ?? new Set<string>()
        checked++

        // ── SET COMPARISON, NOT JUST COUNTS ────────────────────────────────
        // Which of FamilyMeal's newest orders is Disco actually missing? This
        // is what catches a missing order when the counts happen to match, as
        // they did for Local Smoke BBQ.
        let missingRecent: FmOrderBrief[] = []
        if (res.recent.length) {
          const refs = res.recent.map(o => o.reference)
          const have = (await sql`
            SELECT fm_order_reference::text AS fr FROM disco_orders
            WHERE restaurant_reference::text = ${ref}
              AND fm_order_reference = ANY(${refs}::uuid[]) AND is_deleted = false
          `.catch(() => [])) as { fr: string }[]
          const haveSet = new Set(have.map(h => String(h.fr)))
          // A row that CANNOT mirror is not news -- but that is judged from the
          // row FM just returned, not from what was true last time. Everything
          // else that is absent IS news, whatever the counts say.
          missingRecent = res.recent.filter(o => !haveSet.has(o.reference) && !nonMirrorable(ref, o))
        }
        // last_checked_at is written for EVERY successful check, fetch or not —
        // it answers "is this restaurant being watched", not "did it change".
        await sql`
          INSERT INTO disco_fm_sync_watch (restaurant_reference, last_checked_at, last_fm_total, last_neon_count, known_gap, consecutive_errors, updated_at)
          VALUES (${ref}::uuid, NOW(), ${fmTotal}, ${neonCount}, ${Math.max(0, Math.min(gap, was))}, 0, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE
            SET last_checked_at = NOW(), last_fm_total = ${fmTotal}, last_neon_count = ${neonCount},
                consecutive_errors = 0, updated_at = NOW()
        `.catch(() => {})
        // Two independent triggers. Either is enough.
        //   • a NAMED recent order Disco does not have — immune to count maths
        //   • the count gap exceeding the number of confirmed-unmirrorable rows
        if (missingRecent.length) {
          needsFetch.push({ ref, fmTotal, neonCount, gap, was,
            reason: `missing recent order(s): ${missingRecent.map(o => '#' + o.orderNumber).join(', ')}` })
        } else if (gap > base.size) {
          needsFetch.push({ ref, fmTotal, neonCount, gap, was, reason: `count gap ${gap} exceeds ${base.size} confirmed-unmirrorable` })
        }
      }
    }
    await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, () => worker()))
    const pass1Ms = Date.now() - startedAt

    // ── PASS 2: pull orders, only where the gap grew ─────────────────────────
    // Sorted newest-first by fetchFmOrdersPage, so one page covers up to 50 new
    // orders — far beyond the measured maximum of 6 in any hour.
    const fetched: { ref: string; inserted: number; updated: number; residualGap: number; baselined: number; stillMissing: number; ms: number }[] = []
    const failures: { ref: string; error: string }[] = []
    for (const n of needsFetch.slice(0, FETCH_CAP)) {
      if (Date.now() > deadline) break
      const t0 = Date.now()
      try {
        const out = await syncRestaurantOrders(n.ref, { withItems: true, pageSize: 50, maxPages: 2, stopAtKnownDate: true })
        const after = await neonCountFor(n.ref)

        // ── THE BASELINE ONLY EVER ABSORBS CLASSIFIED ROWS ──────────────────
        // This used to be `residual = fmTotal - after` — "whatever remains
        // becomes the new baseline". That sentence is what swallowed three live
        // orders on 19 Oct: a real order that failed to arrive became an
        // anonymous +1 on a counter, and every later run compared against it and
        // saw nothing wrong.
        //
        // Now a reference enters the baseline ONLY after being named and
        // classified as something Neon structurally cannot hold:
        //   • a cart (CART / SELECTED) — FamilyMeal counts them, Neon never
        //     stores them;
        //   • EXPIRED or CANCELED with no customer email — disco_orders
        //     .customer_email is NOT NULL, so upsertOne can only skip it;
        //   • a known duplicate order number — one row per colliding group can
        //     ever exist (lib/known-fm-order-duplicates.ts).
        //
        // Anything else still missing stays OUT of the baseline. It will trigger
        // again next cycle, which is the correct outcome: a real order that
        // cannot be mirrored should keep asking, loudly, not disappear into a
        // number.
        const page = await fmGet(`restaurants/${n.ref}/orders?page=0&size=100&sort=orderDate,desc`, auth)
        const items = (page?.content as Record<string, unknown>[] | undefined) ?? []
        const have2 = (await sql`
          SELECT fm_order_reference::text AS fr FROM disco_orders
          WHERE restaurant_reference::text = ${n.ref}
            AND fm_order_reference IS NOT NULL AND is_deleted = false
        `.catch(() => [])) as { fr: string }[]
        const haveSet2 = new Set(have2.map(h => String(h.fr)))
        const confirmed: string[] = []
        const stillReal: string[] = []
        for (const o of items) {
          const oref = String(o.reference ?? '')
          if (!oref || haveSet2.has(oref)) continue
          const num = String(o.orderNumber ?? '')
          if (nonMirrorable(n.ref, {
            orderStatus: String(o.orderStatus ?? '').toUpperCase(),
            orderNumber: num,
            hasEmail: !!o.email,
          })) confirmed.push(oref)
          else stillReal.push(num)
        }
        if (stillReal.length) {
          console.warn(`[cron/fm-order-watch] ${n.ref}: ${stillReal.length} order(s) still missing after a fetch and NOT baselined: ${stillReal.slice(0, 10).join(', ')}`)
        }
        const residual = Math.max(0, n.fmTotal - after)
        await sql`
          UPDATE disco_fm_sync_watch
          SET known_gap = ${residual}, baseline_refs = ${JSON.stringify(confirmed)}::jsonb,
              last_neon_count = ${after}, last_synced_at = NOW(), updated_at = NOW()
          WHERE restaurant_reference = ${n.ref}::uuid
        `.catch(() => {})
        fetched.push({ ref: n.ref, inserted: out.inserted, updated: out.updated, residualGap: residual,
          baselined: confirmed.length, stillMissing: stillReal.length, ms: Date.now() - t0 })
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
