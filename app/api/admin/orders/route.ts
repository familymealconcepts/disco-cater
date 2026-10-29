import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { sql } from '../../../../lib/db'
import { toClientIso } from '../../../../lib/utils/timestamp'
import { emailFailuresFor } from '../../../../lib/email-failures'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Disco-native orders (fm_order_reference IS NULL) exist only in Neon and are
// absent from FM's admin list. Fetch them mapped into FM's list shape so the admin
// Orders page shows them alongside FM orders. Tagged native:true so the UI can
// badge them; sourceoforder passes through the real stored value (previously
// hardcoded 'DISCO', which mislabeled genuinely-1P native orders as 3P — see
// the super-admin-native-order-source-hardcode-bug investigation). Honors the
// same date range as the FM call.
//
// THIS is the merge boundary — the one place native rows get shaped to sit
// alongside FM's JSON before the client ever sees them — so it's also where
// both classes of native/FM mismatch get normalized, not the comparator:
//   - createdDate goes through toClientIso (always "Z"-suffixed UTC, matching
//     FM's own format). A bare to_char(created_at, '...HH24:MI:SS') used to
//     sit here instead — real UTC digits with no marker — which a client-side
//     Date.parse() reads as LOCAL time, not UTC. Confirmed this silently
//     outranked genuinely more-recent FM orders (2026-08-14).
//   - total/orderNumber are cast to real numbers. Postgres returns NUMERIC/
//     BIGINT columns as strings (precision safety) while FM's JSON has real
//     numbers; left as-is, any comparator with a typeof-gated numeric path
//     silently falls through to a lexicographic string compare the moment a
//     native and FM row are compared (confirmed for `total` the same day).
//     Normalizing here means a future numeric column added to disco_orders
//     can't reproduce this by accident — there's no comparator branch left to
//     forget to update.
async function fetchNativeOrders(fromIso: string | null, toIso: string | null): Promise<Record<string, unknown>[]> {
  try {
    const rows = (await sql`
      SELECT o.reference::text AS "orderReference",
             o.restaurant_reference::text AS "restaurantReference",
             COALESCE(o.restaurant_name, rc.name, '') AS "restaurantName",
             rc.timezone AS "restaurantTimezone",
             o.created_at AS "createdAtRaw",
             to_char(o.order_date, 'YYYY-MM-DD') AS "orderDate",
             o.order_time::text AS "orderTime",
             o.order_type AS "orderType", o.order_status AS "orderStatus",
             COALESCE(o.total, 0) AS total,
             o.customer_first_name AS "firstName", o.customer_last_name AS "lastName", o.customer_email AS email,
             o.order_number AS "orderNumber", o.delivery_type AS "deliveryType",
             o.source_of_order AS sourceoforder, o.is_direct_entry AS "isDirectEntry", true AS native,
             -- Transferred order: "Paid to X, prepared by Y" (lib/order/money-location.ts).
             CASE WHEN m.paid_ref <> o.restaurant_reference
               THEN 'Paid to ' || COALESCE(pc.name, 'the original location') || ', prepared by ' || COALESCE(o.restaurant_name, rc.name, 'this location')
             END AS "moneyLocationNote",
             -- The Stripe fee on refunds: taken from the restaurant, and still owed (lib/order/refund-stripe-fee.ts).
             (SELECT COALESCE(SUM(f.recovered_amount), 0)::float FROM disco_refund_stripe_fees f WHERE f.order_reference = o.reference::text) AS "refundFeeRecovered",
             (SELECT COALESCE(SUM(f.fee_amount - f.recovered_amount), 0)::float FROM disco_refund_stripe_fees f WHERE f.order_reference = o.reference::text) AS "refundFeeUncollected"
      FROM disco_orders o
      CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS (SELECT 1 FROM disco_order_events te
                                              WHERE te.order_reference = o.reference AND te.event_type = 'TRANSFERRED')
        THEN COALESCE(
          (SELECT sp.restaurant_reference FROM disco_stripe_payments sp
            WHERE sp.order_reference = o.reference AND sp.status = 'SUCCEEDED' AND sp.restaurant_reference IS NOT NULL
            ORDER BY sp.created_at, sp.id LIMIT 1),
          (SELECT (e.event_data->>'from_restaurant')::uuid FROM disco_order_events e
            WHERE e.order_reference = o.reference AND e.event_type = 'TRANSFERRED'
            ORDER BY e.created_at LIMIT 1),
          o.restaurant_reference)
        ELSE o.restaurant_reference END AS paid_ref) m
      LEFT JOIN disco_restaurant_cache pc ON pc.restaurant_reference = m.paid_ref::text
      -- rc is joined ONLY for display fields (name/timezone) — never add an
      -- is_live/visible/archived_at predicate on it. An archived restaurant's
      -- orders must keep showing up here exactly as before; archiving is not
      -- deletion.
      LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
      WHERE o.fm_order_reference IS NULL AND o.is_deleted = false
        AND (${fromIso}::date IS NULL OR o.order_date >= ${fromIso}::date)
        AND (${toIso}::date IS NULL OR o.order_date <= ${toIso}::date)
      ORDER BY o.created_at DESC
      LIMIT 500
    `) as Record<string, unknown>[]
    return rows.map((r) => {
      const { createdAtRaw, ...rest } = r
      return {
        ...rest,
        createdDate: toClientIso(createdAtRaw),
        total: Number(rest.total ?? 0),
        orderNumber: Number(rest.orderNumber ?? 0),
      }
    })
  } catch (e) {
    console.error('[admin/orders] native orders fetch failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

// FM filters orders by fromDate/toDate formatted DD.MM.YYYY (known FM gotcha —
// same as the customers endpoint). The date inputs send ISO YYYY-MM-DD, so
// convert before forwarding or FM returns an empty list.
function toFmDate(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  if (sp.get('search')) params.set('search', sp.get('search')!)
  const fromDate = toFmDate(sp.get('fromDate'))
  const toDate = toFmDate(sp.get('toDate'))
  if (fromDate) params.set('fromDate', fromDate)
  if (toDate) params.set('toDate', toDate)
  sp.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/admin/userOrders?${params}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      console.error(`[admin/orders] FM ${res.status} for ?${params} — ${raw.slice(0, 300)}`)
      return NextResponse.json({ error: 'Failed to fetch orders' }, { status: res.status })
    }
    const data = await res.json()

    // Prepend Disco-native orders on the FIRST page only (the client loads every
    // page and concatenates, so page 0 shows them once at the top). totalElements
    // is left as FM's, so pagination is unaffected.
    const isFirstPage = !page || page === '0'
    if (isFirstPage && data && Array.isArray(data.content)) {
      const native = await fetchNativeOrders(sp.get('fromDate') || null, sp.get('toDate') || null)
      if (native.length) data.content = [...native, ...data.content]
    }

    // Order emails Mailgun could not deliver (lib/email-failures.ts), on every
    // page: FM and native rows alike. A number is only unique per restaurant,
    // so a failure attaches to a row when its restaurant matches too.
    if (data && Array.isArray(data.content) && data.content.length) {
      const rows = data.content as Record<string, unknown>[]
      const failures = await emailFailuresFor(rows.map(r => String(r.orderNumber ?? '')))
      if (failures.size) {
        for (const r of rows) {
          const list = failures.get(String(r.orderNumber ?? ''))
          if (!list) continue
          const name = String(r.restaurantName ?? '').trim().toLowerCase()
          const ref = String(r.restaurantReference ?? '')
          const mine = list.filter(f => (!f.restaurantReference && !f.restaurantName)
            || (f.restaurantReference && f.restaurantReference === ref)
            || (f.restaurantName && f.restaurantName.trim().toLowerCase() === name))
          if (mine.length) r.emailFailures = mine.map(({ recipient, reason, eventTime, subject }) => ({ recipient, reason, eventTime, subject }))
        }
      }
    }

    // Delivery address + instructions from Disco's own copy, for native and
    // FamilyMeal rows alike (FM's list carries neither), so the details panel
    // can show them. One query per page; best-effort.
    if (data && Array.isArray(data.content) && data.content.length) {
      const rows = data.content as Record<string, unknown>[]
      const refOf = (r: Record<string, unknown>) => String(r.orderReference ?? r.reference ?? '').toLowerCase()
      const refs = rows.map(refOf).filter(x => UUID_RE.test(x))
      if (refs.length) {
        try {
          const addr = (await sql`
            SELECT COALESCE(fm_order_reference, reference)::text AS ref,
                   delivery_address_line1 AS "deliveryAddressLine1", delivery_address_line2 AS "deliveryAddressLine2",
                   delivery_city AS "deliveryCity", delivery_state AS "deliveryState", delivery_zip AS "deliveryZip",
                   delivery_instructions AS "deliveryInstructions"
            FROM disco_orders
            WHERE (reference = ANY(${refs}::uuid[]) OR fm_order_reference = ANY(${refs}::uuid[]))
              AND order_type = 'DELIVERY' AND (COALESCE(delivery_address_line1, '') <> '' OR COALESCE(delivery_instructions, '') <> '')
          `) as Array<Record<string, unknown> & { ref: string }>
          const byRef = new Map(addr.map(({ ref, ...rest }) => [ref.toLowerCase(), rest]))
          for (const r of rows) {
            const a = byRef.get(refOf(r))
            if (a) Object.assign(r, a)
          }
        } catch (e) {
          console.error('[admin/orders] delivery address lookup failed (non-fatal):', e instanceof Error ? e.message : e)
        }
      }
    }

    const count = Array.isArray(data?.content) ? data.content.length : (Array.isArray(data) ? data.length : 0)
    // Diagnostic: how the FM pagination envelope looks per page fetch.
    console.log(`[admin/orders] page=${page || '0'} size=${params.get('size')} → ${count} orders (totalElements=${data?.totalElements ?? data?.total_elements ?? 'n/a'}, totalPages=${data?.totalPages ?? data?.total_pages ?? 'n/a'})`)
    if (count === 0) {
      console.error(`[admin/orders] FM returned 0 orders for ?${params} (totalElements=${data?.totalElements ?? 'n/a'})`)
    }
    return NextResponse.json(data)
  } catch (err) {
    console.error('[admin/orders] FM request failed:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
