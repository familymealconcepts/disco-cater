import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../../lib/disco-restaurant-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { cookies } from 'next/headers'
import { SELECTED_RESTAURANT_COOKIE } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Normalize a date filter to ISO (the page sends YYYY-MM-DD; accept DD.MM.YYYY too).
function toIso(s: string | null): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s
}

// Default restaurant timezone when disco_restaurant_cache has none on file —
// matches the fallback used elsewhere in the portal (orders/page.tsx).
const RESTAURANT_TZ_DEFAULT = 'America/New_York'

// Financial cards for a Disco-native restaurant — aggregated DIRECTLY from
// disco_orders, the same source the Daily Revenue graph (app/api/restaurant/
// orders/route.ts) and the CSV/Excel/PDF exports already use. disco_orders
// mirrors BOTH FM-origin and native orders for every restaurant, so this
// always reflects real order history — unlike the previous query below, which
// INNER JOINed disco_sale_transactions (populated only by native checkout —
// 21 rows platform-wide against 21,264 real orders) and silently dropped
// every FM-mirrored order that has no such row. That's what produced Net
// Sales $1.00 / 1 order for a restaurant with 318+ real orders.
//
// Trade-off: disco_orders has no tax/lead-gen/delivery-split/tips-split/
// stripe-fee columns — only subtotal/total/fee/tips as combined figures. So
// Net Sales, # of Orders, Avg. Check, and Total Amount are fully reliable
// here; Tax Amount, Lead Gen 1/2, Pickup/Self-Delivery/Third-Party Tips,
// Self-Delivery/Third-Party Delivery (fee), and Stripe Fees genuinely need
// per-order transaction detail that doesn't exist yet for FM-mirrored orders
// (see the FM order-detail backfill scope report) — returned as `null`
// (never a fabricated 0) so the UI can show "Not available" instead of a
// real-looking zero.
async function discoSaleStats(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const from = toIso(sp.get('fromDate'))
  const to = toIso(sp.get('toDate'))
  const byCreated = sp.get('dateType') === 'createdDate'
  const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'

  // Scope: an explicit in-group location wins; else an SA sees their whole group
  // ("All restaurants"), and a single-location admin sees their own.
  //
  // READ-PATH GAP (deliberately deferred, not fixed): "All restaurants" for a
  // disco-native SUPER_ADMIN still means their own group here, not literally
  // every restaurant — a true platform-wide aggregate would need a real
  // list-all query, not built. With no group and no home ref this returns an
  // empty {} (blank cards), never an error and never another owner's figures.
  const queryRef = sp.get('restaurantReference') || ''
  let refs: string[] = []
  let group: { restaurant_reference: string }[] = []
  if (isSA) { try { group = await getDiscoGroupAccounts(ctx.businessName, ctx.email) } catch { group = [] } }
  if (queryRef && UUID_RE.test(queryRef) && (queryRef === ctx.restaurantReference || group.some(g => g.restaurant_reference === queryRef))) {
    refs = [queryRef]
  } else if (isSA && !queryRef) {
    refs = [...new Set([ctx.restaurantReference, ...group.map(g => g.restaurant_reference)].filter(Boolean))]
  } else {
    refs = [await resolveDiscoScopeRef(ctx)]
  }
  refs = refs.filter(r => UUID_RE.test(r))
  if (!refs.length) return NextResponse.json({})

  await runDiscoOrderMigrations()
  // Created Date mode needs the restaurant's OWN local date, not created_at's
  // UTC date — `created_at AT TIME ZONE tz` converts the timestamptz to that
  // zone's wall-clock time before the ::date cast. (Previously this cast had
  // no timezone conversion at all, so "Created Date" mode used the UTC day
  // boundary — a real bug in its own right, separate from the join issue.)
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS "totalOrdersCount",
      COALESCE(SUM(o.subtotal), 0)::float8 AS "subtotalOrdersSum",
      COALESCE(AVG(o.subtotal), 0)::float8 AS "subtotalOrdersAvg",
      COALESCE(SUM(o.total), 0)::float8 AS "totalOrdersSum"
    FROM disco_orders o
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    WHERE o.restaurant_reference = ANY(${refs}::uuid[])
      AND o.is_deleted = false
      AND o.order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
      AND (
        ${from}::date IS NULL OR
        (CASE WHEN ${byCreated}
           THEN (o.created_at AT TIME ZONE COALESCE(rc.timezone, ${RESTAURANT_TZ_DEFAULT}))::date
           ELSE o.order_date
         END) >= ${from}::date
      )
      AND (
        ${to}::date IS NULL OR
        (CASE WHEN ${byCreated}
           THEN (o.created_at AT TIME ZONE COALESCE(rc.timezone, ${RESTAURANT_TZ_DEFAULT}))::date
           ELSE o.order_date
         END) <= ${to}::date
      )
  `) as Record<string, unknown>[]

  // Genuinely unavailable until the FM order-detail backfill lands — null
  // (never 0) so the UI shows "Not available" rather than a real-looking zero.
  const unavailable = {
    stateSalesTaxInPriceSum: null, localSalesTaxInPriceSum: null, otherSalesTaxInPriceSum: null,
    leadgenonediscofee: null, leadgentwodiscofee: null,
    serviceChargesSum: null, stripeFeeSum: null,
    ownDeliveryPriceSum: null, thirdPartyDeliveryFeeSum: null, doordashDeliveryFeeSum: null,
    pickupTipsInPrice: null, owndeliveryTipsInPrice: null,
    thirdPartyDeliveryTipsOrdersSum: null, doordashTipsOrdersSum: null,
  }
  return NextResponse.json({ ...(rows[0] || {}), ...unavailable })
}

// FM's dashboard expects dates as DD.MM.YYYY (DateFormatService.formatDate,
// _system/_services/dateformatting/dateformatting.service.ts:11-17). The
// <input type="date"> on the page yields ISO YYYY-MM-DD, which FM silently
// treats as no-match — the financial cards come back empty. Convert here.
function toFmDate(iso: string | null): string | null {
  if (!iso) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Disco-native restaurants: aggregate real numbers from Neon (was FM → always $0).
  if (ctx.authType === 'disco') {
    return discoSaleStats(ctx, req)
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const role = await getRestaurantRole()
  const store = await cookies()
  const cookieRef = store.get(SELECTED_RESTAURANT_COOKIE)?.value

  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  const fromDate = toFmDate(searchParams.get('fromDate'))
  const toDate = toFmDate(searchParams.get('toDate'))
  if (fromDate) params.set('fromDate', fromDate)
  if (toDate) params.set('toDate', toDate)
  if (searchParams.get('dateType')) params.set('dateType', searchParams.get('dateType')!)

  // Resolve which restaurant to scope stats to, in priority order:
  //   1. ?restaurantReference= on the query (Reporting dropdown — used
  //      by SUPER_ADMIN who never sets a selected-restaurant cookie,
  //      and SYSTEM_ADMIN who picked from the dropdown).
  //   2. The fm_selected_restaurant cookie (SA who clicked into a
  //      location from /restaurant/manage/locations).
  //   3. The JWT-derived ref (ADMIN role — single-restaurant staff).
  const queryRef = searchParams.get('restaurantReference') || ''
  let scopedRef = queryRef || cookieRef || ''
  if (!scopedRef && (role === 'ADMIN' || role === 'RESTAURANT_USER' || role === 'RESTAURANT_ADMIN')) {
    scopedRef = (await getRestaurantRef()) || ''
  }
  if (scopedRef) params.set('restaurantReference', scopedRef)

  // Endpoint is chosen by ROLE, not by whether a ref is present. FM
  // splits the two paths:
  //   ADMIN / RESTAURANT_USER → /api/dashboard/sale/stats
  //     (single-restaurant staff; JWT carries the restaurant, but the
  //     deployed FM also wants the param explicitly — confirmed earlier)
  //   SYSTEM_ADMIN / SUPER_ADMIN → /api/system-admin/dashboard/sale/stats
  //     (always — restaurantReference param scopes to one location, or
  //     is omitted to return the all-restaurants aggregate)
  //
  // Previously we routed SA-with-selection to the ADMIN endpoint with
  // the param attached, which FM rejected with 400 — the ADMIN endpoint
  // doesn't accept restaurantReference for SA tokens.
  const isMultiRole = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'
  const url = isMultiRole
    ? `${FM}/api/system-admin/dashboard/sale/stats?${params}`
    : `${FM}/api/dashboard/sale/stats?${params}`
  try {
    const res = await fetch(url, { headers: authHeaders })
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed', fmStatus: res.status }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
  }
}
