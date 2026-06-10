import { NextResponse } from 'next/server'
import { validateApiKey } from '../../../../lib/api-key-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { sql } from '../../../../lib/db'

// Read-only order export for CRM sync (last 365 days). API-key protected.
//
// Source of truth is Disco's own Neon order store (disco_orders), which carries
// customer_email — FM's order list does not. We still page FM's platform-wide
// order list (for any order not yet in Neon, e.g. legacy/FM-only), then merge:
// Neon rows win on dedup since they have email.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

type FmRow = Record<string, unknown>

interface ExportOrder {
  orderRef: string | null
  orderNumber: unknown
  customerEmail: string | null
  customerName: string | null
  restaurantName: string | null
  restaurantReference: string | null
  orderDate: unknown
  orderType: string | null
  sourceOfOrder: string | null
  subtotal: number | null
  total: number | null
  orderStatus: string | null
  tips: number | null
  deliveryFee: number | null
}

// 365 days ago as DD.MM.YYYY (FM's expected date format).
function fromDate365(): string {
  const d = new Date(Date.now() - 365 * 86_400_000)
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}.${mm}.${yyyy}`
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
    customerEmail: r.customer_email ?? null,
    customerName: name,
    restaurantName: r.restaurant_name ?? null,
    restaurantReference: r.restaurant_reference ?? null,
    orderDate: r.order_date ?? null,
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

  try {
    // 1) Disco-native orders from Neon (these carry customer_email). One row per
    // order: LATERAL-join the latest sale transaction for the money fields. If
    // Neon is unreachable we fall back to FM-only rather than failing the export.
    let discoOrders: ExportOrder[] = []
    const neonRefs = new Set<string>()
    try {
      const rows = (await sql`
        SELECT o.reference, o.order_number, o.customer_email,
               o.customer_first_name, o.customer_last_name,
               o.restaurant_name, o.restaurant_reference, o.order_date, o.order_type,
               o.source_of_order, o.order_status, o.tips, o.fm_order_reference,
               t.subtotal, t.total, t.own_delivery_fee, t.third_party_delivery_fee
        FROM disco_orders o
        LEFT JOIN LATERAL (
          SELECT subtotal, total, own_delivery_fee, third_party_delivery_fee
          FROM disco_sale_transactions st
          WHERE st.order_id = o.id
          ORDER BY st.transaction_version DESC, st.id DESC
          LIMIT 1
        ) t ON true
        WHERE o.created_at > NOW() - INTERVAL '365 days'
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

    // 2) FM platform-wide order list (last 365 days), as before.
    const fromDate = fromDate365()
    const SIZE = 200
    const MAX_PAGES = 200
    const fmRaw: FmRow[] = []
    let header = await getFmServiceAuthHeader()
    let page = 0
    let totalPages = 1
    let retried = false

    while (page < totalPages && page < MAX_PAGES) {
      const params = new URLSearchParams({ page: String(page), size: String(SIZE), fromDate })
      const res = await fetch(`${FM}/api/admin/userOrders?${params}`, { headers: header, cache: 'no-store' })
      if (res.status === 401 && !retried) {
        retried = true
        header = await getFmServiceAuthHeader(true)
        continue
      }
      if (!res.ok) break
      const d = await res.json().catch(() => null)
      const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
      fmRaw.push(...content)
      totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
      page++
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
        customerEmail: (customer?.email ?? saleCustomer?.email ?? o.userEmail ?? o.customerEmail ?? o.email ?? null) as string | null,
        customerName,
        restaurantName: (o.restaurantName ?? null) as string | null,
        restaurantReference: (o.restaurantReference ?? null) as string | null,
        orderDate: o.orderDate ?? null,
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
    const combined = [...discoOrders, ...fmDeduped]

    return NextResponse.json(combined, { headers: { 'X-Total-Count': String(combined.length) } })
  } catch (e) {
    console.error('[export/orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to export orders' }, { status: 500 })
  }
}
