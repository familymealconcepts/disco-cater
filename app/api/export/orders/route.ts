import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { sql } from '../../../../lib/db'
import { displayEmail } from '../../../../lib/customer-email-guard'

// Read-only order export for CRM sync. API-key protected.
//
// Source of truth is Disco's own Neon order store (disco_orders), which carries
// customer_email — FM's order list does not. We still page FM's platform-wide
// order list (for any order not yet in Neon, e.g. legacy/FM-only), then merge:
// Neon rows win on dedup since they have email.
//
// No default window — omit ?from=/?to= entirely to get full history. Both sides
// (Neon and FM) date orders by COALESCE(placed_at, created_at): placed_at is
// FM's real order-creation timestamp (backfilled for pre-freeze orders, populated
// going forward by the fixed sync); created_at is Neon SYNC time, which for
// FM-mirrored orders can trail real placement by hours to years — dating this
// export by created_at made "last 365 days" a no-op in practice (sync time is
// always recent) while silently misdating everything else.
//
// Pass ?from=YYYY-MM-DD and/or ?to=YYYY-MM-DD to scope a request explicitly
// (recommended for large pulls — see the truncation-safety comment below).

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Stops the FM pagination loop with margin before Vercel's own 300s cutoff, so
// we can return an explicit error while there's still time to respond at all —
// a function killed mid-write by the platform timeout wouldn't get to say
// anything. Measured a real full-history pull (24,316 rows, 122 pages, no date
// filter) at 187s — comfortably under this budget today, but not permanently:
// as FM's order volume grows, a genuinely unbounded pull will eventually exceed
// it. That's the failure mode this guards, not today's volume.
const TIME_BUDGET_MS = 270_000

// A backstop against a pagination bug (e.g. FM's totalPages never converging),
// not a real limit — 5,000 pages is ~1,000,000 rows, an order of magnitude past
// any plausible real volume. If this ever fires, something is actually wrong.
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
               t.subtotal, t.total, t.own_delivery_fee, t.third_party_delivery_fee
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

    // 2) FM platform-wide order list. No default window. Runs until FM reports
    // no more pages (or an empty page), not a fixed page cap. Two independent
    // safety valves, BOTH of which end the request with an explicit error —
    // never a 200 that looks like the full history when it isn't:
    //   - RUNAWAY_GUARD_PAGES: a pagination-bug backstop, not a real limit.
    //   - TIME_BUDGET_MS: stops with margin before Vercel's own maxDuration, so
    //     we can still respond with a clear error instead of being killed
    //     mid-write. See the constant's own comment for the measured baseline.
    //
    // Deliberately NOT passing fromIso/toIso to FM as fromDate/toDate: traced
    // FM's own Java specification (RestaurantOrderInfoSpecification.
    // getPredicateForDate) and confirmed those params filter by ORDER_DATE (the
    // delivery date), not by any creation/placement timestamp — FM's API has no
    // created-date filter at all. Sending our createdDate-scoped from/to as
    // FM's order_date-scoped params produced real, verified leakage (an order
    // booked in one month for delivery in another falls on the wrong side of
    // the filter) — caught by testing a ranged request before trusting it: 65 of
    // 167 rows fell outside the requested window. Always fetching FM's full set
    // and filtering by createdDate client-side (below) is correct regardless of
    // range size; it just means a narrow ?from=/&to= doesn't speed up the FM
    // side today, only the Neon side. Documented, not silent.
    const SIZE = 200
    const fmRaw: FmRow[] = []
    let header = await getFmServiceAuthHeader()
    let page = 0
    let totalPages = 1
    let retried = false
    let truncatedReason: string | null = null

    while (page < totalPages) {
      if (page >= RUNAWAY_GUARD_PAGES) {
        truncatedReason = `exceeded the ${RUNAWAY_GUARD_PAGES}-page runaway guard at page ${page} of ${totalPages} reported by FM`
        break
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        truncatedReason = `exceeded the ${TIME_BUDGET_MS}ms time budget at page ${page} of ${totalPages} reported by FM`
        break
      }

      const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
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
    }

    if (truncatedReason) {
      return NextResponse.json({
        error: "Export incomplete — stopped before fetching FM's full order history",
        reason: truncatedReason,
        ordersFetchedSoFar: discoOrders.length + fmRaw.length,
        recommendation: 'Retry with a narrower ?from=&to= date range to pull this data in smaller chunks.',
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
    // FM's own list was never date-filtered (see the comment above) — apply the
    // createdDate range here, client-side, so the merged output is correctly
    // scoped regardless of range size. Neon's own rows are already filtered by
    // the SQL WHERE clause above; this only touches the FM-only remainder.
    const fmInRange = (fromIso || toIso)
      ? fmDeduped.filter(o => {
          const d = String(o.createdDate || '').slice(0, 10)
          if (!d) return false
          if (fromIso && d < fromIso) return false
          if (toIso && d > toIso) return false
          return true
        })
      : fmDeduped
    const combined = [...discoOrders, ...fmInRange]

    return NextResponse.json(combined, { headers: { 'X-Total-Count': String(combined.length) } })
  } catch (e) {
    console.error('[export/orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export orders' }, { status: 500 })
  }
}
