import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { sql } from '../../../../lib/db'
import { displayEmail } from '../../../../lib/customer-email-guard'

// Read-only order export for CRM sync. API-key protected.
//
// Source of truth is Disco's own Neon order store (disco_orders) — the FM
// missing-row backfill (2026-08) closed the historical gap, so Neon is now
// complete for everything older than the FM leg's own window below. The FM
// leg exists only to cover ongoing sync latency: the hourly cron rotates
// through restaurants in batches (~3.4 days for a full cycle today), so an
// order can be real and current on FM before its restaurant's next turn
// syncs it into Neon. FM_RECENT_WINDOW_DAYS is set generously wider than that
// cycle so the leg reliably covers it; it is NOT a general-purpose historical
// fallback anymore — Neon owns everything past that window. Confirmed via
// checkFmSyncComplete-style diffing before this changed: 0 rows outstanding
// in Neon's own backfill scope, 368 recent (sync-latency) orders were the
// only real gap, all inside a much narrower window than 14 days.
//
// Sorted by FM as createdDate,desc (verified stable — unsorted default
// pagination on this endpoint drifts/jumbles) so the loop can stop as soon as
// a page goes past the window, rather than paging FM's full history.
//
// Neon rows win on dedup (they carry customer_email; FM's own list doesn't).
//
// No default window on the NEON side — omit ?from=/?to= entirely to get full
// history from Neon. Both sides date orders by COALESCE(placed_at, created_at):
// placed_at is FM's real order-creation timestamp (backfilled for pre-freeze
// orders, populated going forward by the fixed sync); created_at is Neon SYNC
// time, which for FM-mirrored orders can trail real placement by hours to
// years — dating this export by created_at made "last 365 days" a no-op in
// practice (sync time is always recent) while silently misdating everything else.
//
// Pass ?from=YYYY-MM-DD and/or ?to=YYYY-MM-DD to scope the Neon side of a
// request explicitly (recommended for large pulls). The FM leg's window is
// independent of these — it always covers the last FM_RECENT_WINDOW_DAYS,
// regardless of what from/to ask for, since anything older is Neon's job now.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ~4x the hourly cron's current full-rotation cycle (~3.4 days) — generous
// margin so a slower cycle (a bigger fleet, a paused cron) doesn't quietly
// reopen the gap this is meant to close.
const FM_RECENT_WINDOW_DAYS = 14

// Stops the FM pagination loop with margin before Vercel's own 300s cutoff —
// now just a backstop (the createdDate,desc + window-cutoff design below means
// a normal run stops after a handful of pages), not the everyday guard it used
// to be when this fetched full unbounded history.
const TIME_BUDGET_MS = 270_000

// A backstop against a pagination bug (e.g. FM's totalPages never converging
// or the sort somehow not holding), not a real limit for a 14-day window.
const RUNAWAY_GUARD_PAGES = 5000

type FmRow = Record<string, unknown>

interface ExportOrder {
  orderRef: string | null
  orderNumber: unknown
  customerEmail: string | null
  customerName: string | null
  restaurantName: string | null
  restaurantReference: string | null
  orderDate: unknown
  createdDate: unknown
  orderType: string | null
  sourceOfOrder: string | null
  subtotal: number | null
  total: number | null
  orderStatus: string | null
  tips: number | null
  deliveryFee: number | null
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Neon (disco_orders) ──────────────────────────────────────────────────────
interface DiscoOrderRow {
  reference: string | null
  order_number: unknown
  customer_email: string | null
  customer_first_name: string | null
  customer_last_name: string | null
  restaurant_name: string | null
  restaurant_reference: string | null
  order_date: unknown
  created_date: unknown
  order_type: string | null
  source_of_order: string | null
  order_status: string | null
  tips: unknown
  fm_order_reference: string | null
  subtotal: unknown
  total: unknown
  own_delivery_fee: unknown
  third_party_delivery_fee: unknown
}

function discoRowToOrder(r: DiscoOrderRow): ExportOrder {
  const name = [r.customer_first_name, r.customer_last_name].filter(Boolean).join(' ') || null
  return {
    orderRef: r.reference ?? null,
    orderNumber: r.order_number ?? null,
    customerEmail: displayEmail(r.customer_email as string | null) || null,
    customerName: name,
    restaurantName: r.restaurant_name ?? null,
    restaurantReference: r.restaurant_reference ?? null,
    orderDate: r.order_date ?? null,
    createdDate: r.created_date ?? null,
    orderType: r.order_type ?? null,
    sourceOfOrder: r.source_of_order ?? null,
    subtotal: num(r.subtotal),
    total: num(r.total),
    orderStatus: r.order_status ?? null,
    tips: num(r.tips),
    deliveryFee: num(r.own_delivery_fee ?? r.third_party_delivery_fee),
  }
}

export async function GET(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const fromIso = url.searchParams.get('from')
  const toIso = url.searchParams.get('to')
  if (fromIso && !DATE_RE.test(fromIso)) return NextResponse.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 })
  if (toIso && !DATE_RE.test(toIso)) return NextResponse.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 })

  const startedAt = Date.now()

  try {
    // 1) Disco-native orders from Neon (these carry customer_email). One row per
    // order: LATERAL-join the latest sale transaction for the money fields. If
    // Neon is unreachable we fall back to FM-only rather than failing the export.
    // Dated by COALESCE(placed_at, created_at) — see the file header comment.
    let discoOrders: ExportOrder[] = []
    const neonRefs = new Set<string>()
    try {
      const rows = (await sql`
        SELECT o.reference, o.order_number, o.customer_email,
               o.customer_first_name, o.customer_last_name,
               o.restaurant_name, o.restaurant_reference, o.order_date, o.order_type,
               o.source_of_order, o.order_status, o.tips, o.fm_order_reference,
               COALESCE(o.placed_at, o.created_at) AS created_date,
               -- Header fallback for orders with no transaction row at all (no
               -- sync ever writes one for a plain FAMILYMEAL order without
               -- withItems, until repaired) — o.total/subtotal are set at
               -- header-insert time regardless, so a bare order still reports
               -- its real total instead of a null that looks like $0.
               COALESCE(t.subtotal, o.subtotal) AS subtotal,
               COALESCE(t.total, o.total) AS total,
               t.own_delivery_fee, t.third_party_delivery_fee
        FROM disco_orders o
        LEFT JOIN LATERAL (
          SELECT subtotal, total, own_delivery_fee, third_party_delivery_fee
          FROM disco_sale_transactions st
          WHERE st.order_id = o.id
          ORDER BY st.transaction_version DESC, st.id DESC
          LIMIT 1
        ) t ON true
        WHERE (${fromIso}::date IS NULL OR COALESCE(o.placed_at, o.created_at)::date >= ${fromIso}::date)
          AND (${toIso}::date IS NULL OR COALESCE(o.placed_at, o.created_at)::date <= ${toIso}::date)
      `) as DiscoOrderRow[]
      discoOrders = rows.map(discoRowToOrder)
      // Track both Disco's own reference and the linked FM reference so the FM
      // copy of the same order is deduped out below.
      for (const r of rows) {
        if (r.reference) neonRefs.add(String(r.reference))
        if (r.fm_order_reference) neonRefs.add(String(r.fm_order_reference))
      }
    } catch (e) {
      console.error('[export/orders] Neon disco_orders query failed, FM-only:', e instanceof Error ? e.message : e)
    }

    // 2) FM's recent order list — bounded to FM_RECENT_WINDOW_DAYS, not FM's
    // full history. Sorted createdDate,desc (verified stable server-side —
    // the endpoint's unsorted default drifts across pages) so the loop can
    // stop as soon as a page goes past the window, the same "stop once we've
    // reached known territory" shape as the sync's stopAtKnownDate. Two
    // independent safety valves remain, BOTH of which end the request with an
    // explicit error — never a 200 that looks complete when it isn't:
    //   - RUNAWAY_GUARD_PAGES: a pagination-bug backstop, not a real limit —
    //     a 14-day window is normally a handful of pages.
    //   - TIME_BUDGET_MS: stops with margin before Vercel's own maxDuration.
    //
    // order_date (FM's fromDate/toDate params) is the delivery date, not a
    // creation timestamp (traced FM's own Java spec, confirmed with a real
    // ranged request: 65 of 167 rows fell outside the requested window when
    // sent as fromDate/toDate) — irrelevant to this leg now, since it sorts
    // and filters by createdDate directly instead of asking FM to filter at all.
    const SIZE = 200
    const fmRaw: FmRow[] = []
    let header = await getFmServiceAuthHeader()
    let page = 0
    let totalPages = 1
    let retried = false
    let truncatedReason: string | null = null
    const windowCutoffMs = Date.now() - FM_RECENT_WINDOW_DAYS * 86_400_000

    while (page < totalPages) {
      if (page >= RUNAWAY_GUARD_PAGES) {
        truncatedReason = `exceeded the ${RUNAWAY_GUARD_PAGES}-page runaway guard at page ${page} of ${totalPages} reported by FM`
        break
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        truncatedReason = `exceeded the ${TIME_BUDGET_MS}ms time budget at page ${page} of ${totalPages} reported by FM`
        break
      }

      const params = new URLSearchParams({ page: String(page), size: String(SIZE), sort: 'createdDate,desc' })
      const res = await fetch(`${FM}/api/admin/userOrders?${params}`, { headers: header, cache: 'no-store' })
      if (res.status === 401 && !retried) {
        retried = true
        header = await getFmServiceAuthHeader(true)
        continue
      }
      if (!res.ok) {
        truncatedReason = `FM returned HTTP ${res.status} at page ${page}`
        break
      }
      const d = await res.json().catch(() => null)
      const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
      fmRaw.push(...content)
      totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
      page++
      // An empty/short final page also means we're done, regardless of what
      // totalPages claims — never keep looping past what FM actually returned.
      if (content.length === 0) break
      // Stop once this page's oldest order is past the window — the whole
      // page is still processed first (a same-page mix of in/out-of-window
      // rows is filtered below, not silently dropped), matching
      // stopAtKnownDate's "boundary page always fully processed" rule.
      const oldestOnPageMs = content.reduce((oldest: number, o: FmRow) => {
        const t = Date.parse(String(o.createdDate ?? o.orderCreatedDate ?? ''))
        return Number.isFinite(t) && t < oldest ? t : oldest
      }, Infinity)
      if (oldestOnPageMs < windowCutoffMs) break
    }

    if (truncatedReason) {
      return NextResponse.json({
        error: "Export incomplete — stopped before finishing FM's recent-order window",
        reason: truncatedReason,
        ordersFetchedSoFar: discoOrders.length + fmRaw.length,
        recommendation: 'Retry — a transient FM error or an unexpectedly large recent-order volume, not the historical scope (Neon owns that now).',
      }, { status: 503 })
    }

    const fmOrders: ExportOrder[] = fmRaw.map((o) => {
      const customer = o.customer as FmRow | undefined
      const saleCustomer = (o.saleTransaction as FmRow | undefined)?.customer as FmRow | undefined
      const nestedName = [customer?.firstName, customer?.lastName].filter(Boolean).join(' ')
      const topName = [o.firstName, o.lastName].filter(Boolean).join(' ')
      const customerName = nestedName || topName || (o.userName as string | undefined) || null
      return {
        orderRef: (o.orderReference ?? o.reference ?? null) as string | null,
        orderNumber: o.orderNumber ?? null,
        // FM's own live data would never carry this synthetic placeholder (it's
        // only ever written to disco_orders by the missing-row backfill), but
        // guard defensively anyway — same helper, zero cost.
        customerEmail: displayEmail((customer?.email ?? saleCustomer?.email ?? o.userEmail ?? o.customerEmail ?? o.email ?? null) as string | null) || null,
        customerName,
        restaurantName: (o.restaurantName ?? null) as string | null,
        restaurantReference: (o.restaurantReference ?? null) as string | null,
        orderDate: o.orderDate ?? null,
        // FM-only orders (not mirrored in Neon) have no placed_at concept to
        // fall back from — FM's own createdDate is already its real placement
        // timestamp for these (this export never reads FM's DB directly).
        createdDate: o.createdDate ?? o.orderCreatedDate ?? null,
        orderType: (o.orderType ?? null) as string | null,
        sourceOfOrder: (o.sourceoforder ?? o.sourceOfOrder ?? null) as string | null,
        subtotal: num(o.subtotal),
        total: num(o.total ?? o.transactionsTotal),
        orderStatus: (o.orderStatus ?? o.status ?? null) as string | null,
        tips: num(o.tips),
        deliveryFee: num(o.deliveryFee),
      }
    })

    // 3) Merge: Neon rows first (precedence), then FM rows whose orderRef isn't
    // already represented by a Neon order (matched on Disco ref or fm_order_reference).
    const fmDeduped = fmOrders.filter(o => !o.orderRef || !neonRefs.has(String(o.orderRef)))
    // Client-side createdDate filter: always enforce the window cutoff (the
    // boundary page above is fetched whole, so it can contain rows older than
    // the window mixed in with ones still inside it — those belong to Neon,
    // not this leg) — plus any explicit ?from=/&to=, narrower or not, same as
    // before. Neon's own rows are already filtered by the SQL WHERE clause
    // above; this only touches the FM-only remainder.
    const windowCutoffIso = new Date(windowCutoffMs).toISOString().slice(0, 10)
    const fmInRange = fmDeduped.filter(o => {
      const d = String(o.createdDate || '').slice(0, 10)
      if (!d) return false
      if (d < windowCutoffIso) return false
      if (fromIso && d < fromIso) return false
      if (toIso && d > toIso) return false
      return true
    })
    const combined = [...discoOrders, ...fmInRange]

    return NextResponse.json(combined, { headers: { 'X-Total-Count': String(combined.length) } })
  } catch (e) {
    console.error('[export/orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export orders' }, { status: 500 })
  }
}
