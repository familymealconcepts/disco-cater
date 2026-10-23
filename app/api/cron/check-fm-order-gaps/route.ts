// Cron: daily gap check between FamilyMeal's real orders and Disco's mirror,
// for every converted (Disco-native) restaurant.
//
// WHY THIS EXISTS. The hourly mirror (cron/sync-fm-orders) stalled for 51 hours
// in October 2026 and nothing said so: the cursor sat at offset 906, the run
// returned 500 every hour, and the only signal was a human noticing that Rooted
// Cafe & Catering's $958.23 order had never appeared. The mirror now defends
// itself three ways (per-restaurant guards, an optimistic cursor claim, and
// reconciliation that no longer trips on permanent duplicates), but defences
// fail quietly too. This is the independent check: it does not trust the
// mirror's own reporting, it compares FamilyMeal to Neon directly.
//
// HOW IT KEEPS COST DOWN. A full order-list pull for 397 converted restaurants
// cannot finish inside maxDuration. So this runs in two passes:
//
//   1. CHEAP: one `size=1` call per restaurant, read totalElements. Measured
//      ~350ms, against ~10s for a size=50 page. A missing order always makes
//      FM's total exceed Neon's fm_order_reference count, so this finds every
//      candidate without paging anybody.
//   2. EXPENSIVE, ONLY WHERE PASS 1 FOUND A GAP: pull the recent list and name
//      the specific orders.
//
// WHAT COUNTS AS A REAL ORDER. CART and SELECTED are baskets FamilyMeal counts
// and Neon deliberately never stores (NON_ORDER_FM_STATUSES). Rows with no
// customer email are ALSO unmirrorable — disco_orders.customer_email is NOT
// NULL, so upsertOne skips them — and they are overwhelmingly abandoned
// checkouts (verified: Pelican Delicatessen's four absentees are all EXPIRED
// with a null email and a null total). Alerting on either would mean alerting
// forever about something no fix can change, which trains people to ignore the
// channel. Both are counted and reported in the response, never alerted.
//
// GRACE PERIOD. An order is only alerted once it has been in FamilyMeal for more
// than 2 hours, so a normal mirror lag (hourly cron) never pages anyone.
//
// REQUIRED ENV: CRON_SECRET.

import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { alertGroup, openAlertKeys, resolveAlert, noteJobFailure, noteJobSuccess } from '../../../../lib/ops-alert'
import { money, formatDay } from '../../../../lib/ops-alert-format'
import { recordMirrorAlert } from '../../../../lib/mirror-alert'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { fmFetch } from '../../../../lib/fm-fetch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const LOOKBACK_DAYS = 7
const GRACE_MS = 2 * 60 * 60 * 1000
const TIME_BUDGET_MS = 240_000
const COUNT_CONCURRENCY = 4
// Pass 2 is the slow one; cap it so a bad day cannot turn this into an
// unbounded job. Anything beyond the cap is still COUNTED in the alert.
const DETAIL_CAP = 25
const NON_ORDER = new Set(['CART', 'SELECTED'])

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

type FmOrder = {
  reference?: string
  orderNumber?: number | string
  orderStatus?: string
  orderDate?: string
  createdDate?: string
  total?: number | null
  email?: string | null
}

/** Both URL shapes, same order as the mirror tries them. */
async function fmGet(path: string, auth: Record<string, string>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  for (const url of [`${FM}/public-api/v2/${path}`, `${FM}/api/admin/${path}`]) {
    try {
      const res = await fmFetch(url, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
      if (!res.ok) continue
      return (await res.json().catch(() => null)) as Record<string, unknown> | null
    } catch { /* try the next shape */ }
  }
  return null
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  const deadline = startedAt + TIME_BUDGET_MS
  try {
    await runMigrations()

    const rows = (await sql`
      SELECT DISTINCT c.restaurant_reference::text AS ref, c.name
      FROM disco_restaurant_cache c
      JOIN disco_orders o ON o.restaurant_reference::text = c.restaurant_reference::text
      WHERE c.is_disco_native = true
        AND o.source_of_order = 'FAMILYMEAL'
        AND o.is_deleted = false
      ORDER BY 2
    `.catch(() => [])) as { ref: string; name: string | null }[]
    const targets = rows.filter(r => isUuid(r.ref))

    const auth = await getFmServiceAuthHeader()

    // ── PASS 1: counts ───────────────────────────────────────────────────────
    const gapped: { ref: string; name: string | null; fmTotal: number; neonCount: number }[] = []
    let countChecked = 0
    let i = 0
    const countWorker = async () => {
      for (;;) {
        const k = i++
        if (k >= targets.length || Date.now() > deadline) return
        const t = targets[k]
        const j = await fmGet(`restaurants/${t.ref}/orders?page=0&size=1`, auth, 30_000)
        const fmTotal = typeof j?.totalElements === 'number' ? (j.totalElements as number) : null
        countChecked++
        if (fmTotal == null) continue
        const n = (await sql`
          SELECT COUNT(*)::int AS n FROM disco_orders
          WHERE restaurant_reference::text = ${t.ref}
            AND fm_order_reference IS NOT NULL AND is_deleted = false
        `.catch(() => [])) as { n: number }[]
        const neonCount = n[0]?.n ?? 0
        if (fmTotal > neonCount) gapped.push({ ref: t.ref, name: t.name, fmTotal, neonCount })
      }
    }
    await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, () => countWorker()))

    // ── PASS 2: name the orders, only where pass 1 saw a gap ─────────────────
    const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000
    const missing: { fmRef: string; restaurant: string; orderNumber: string; total: string; orderDate: string; status: string }[] = []
    let unmirrorable = 0
    let carts = 0
    let detailChecked = 0

    for (const g of gapped.slice(0, DETAIL_CAP)) {
      if (Date.now() > deadline) break
      detailChecked++
      const j = await fmGet(`restaurants/${g.ref}/orders?page=0&size=100&sort=orderDate,desc`, auth, 30_000)
      const items = (j?.content as FmOrder[] | undefined) || []
      if (!items.length) continue
      const have = (await sql`
        SELECT fm_order_reference::text AS fr FROM disco_orders
        WHERE restaurant_reference::text = ${g.ref}
          AND fm_order_reference IS NOT NULL AND is_deleted = false
      `.catch(() => [])) as { fr: string }[]
      const haveSet = new Set(have.map(h => String(h.fr)))

      for (const o of items) {
        const ref = String(o.reference || '')
        if (!ref || haveSet.has(ref)) continue
        const status = String(o.orderStatus || '').toUpperCase()
        if (NON_ORDER.has(status)) { carts++; continue }
        // Structurally unmirrorable: customer_email is NOT NULL in disco_orders.
        if (!o.email) { unmirrorable++; continue }
        // Only orders FamilyMeal has actually had for a while, and only recent ones.
        const created = o.createdDate ? Date.parse(o.createdDate) : NaN
        if (Number.isFinite(created)) {
          if (Date.now() - created < GRACE_MS) continue
          if (created < cutoff) continue
        } else if (o.orderDate && Date.parse(o.orderDate) < cutoff) continue
        missing.push({
          fmRef: ref,
          restaurant: g.name || g.ref,
          orderNumber: String(o.orderNumber ?? '?'),
          total: o.total == null ? 'unknown' : money(o.total),
          orderDate: String(o.orderDate ?? ''),
          status,
        })
      }
    }

    const duration_ms = Date.now() - startedAt
    // One key per FamilyMeal order, posted together; an order already posted is
    // never posted again, and each closes in its thread once it is in Disco.
    const fresh = await alertGroup(missing.map(m => ({ ...m, key: `fm-gap:${m.fmRef.toLowerCase()}:${m.orderNumber}` })), items => ({
      severity: 'warn',
      headline: `${items.length} FamilyMeal order${items.length === 1 ? '' : 's'} missing from Disco`,
      lines: [
        `Older than 2 hours and still not in Disco, so ${items.length === 1 ? "this restaurant's Disco portal doesn't" : "these restaurants' Disco portals don't"} show ${items.length === 1 ? 'it' : 'them'}:`,
        ...items.slice(0, 15).map(m => `• ${m.restaurant} · FM #${m.orderNumber} · ${m.total}${m.orderDate ? ` · for ${formatDay(m.orderDate)}` : ''}`),
        ...(items.length > 15 ? [`…and ${items.length - 15} more`] : []),
      ],
      action: 'nothing if they arrive within the hour; otherwise run the FM order sync.',
      context: { restaurantsWithGap: gapped.length },
    }))
    if (fresh.length) await recordMirrorAlert('order-gap', `${fresh.length} FamilyMeal order(s) missing`, { orders: fresh.map(m => `${m.restaurant} — FM #${m.orderNumber}`) })

    // Close the ones that have arrived — on evidence (the row exists), never
    // because this partial check happened not to look at them.
    const openGap = await openAlertKeys('fm-gap:')
    if (openGap.length) {
      const refs = openGap.map(k => k.split(':')[1])
      const arrived = new Set(((await sql`
        SELECT LOWER(fm_order_reference::text) AS r FROM disco_orders WHERE fm_order_reference::text = ANY(${refs})
      `.catch(() => [])) as Array<{ r: string }>).map(x => x.r))
      for (const k of openGap) {
        const [, ref, n] = k.split(':')
        if (arrived.has(ref)) await resolveAlert(k, `FM #${n} is in Disco now.`)
      }
    }
    await noteJobSuccess('check-fm-order-gaps')

    console.log(`[cron/check-fm-order-gaps] converted=${targets.length} countChecked=${countChecked} gapped=${gapped.length} detailChecked=${detailChecked} missing=${missing.length} carts=${carts} unmirrorable=${unmirrorable} (${duration_ms}ms)`)
    return NextResponse.json({
      converted: targets.length, countChecked, gapped: gapped.length, detailChecked,
      missing, carts, unmirrorable, duration_ms,
    })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('[cron/check-fm-order-gaps] failed:', error)
    await noteJobFailure('check-fm-order-gaps', error)
    await recordMirrorAlert('run-failed', `check-fm-order-gaps FAILED: ${error}`, { error })
    return NextResponse.json({ error: 'gap check failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
