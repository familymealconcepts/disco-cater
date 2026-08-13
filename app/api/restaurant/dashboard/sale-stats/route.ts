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

// Financial cards for a Disco-native restaurant. # of Orders/Net Sales/Avg.
// Check/Total Amount are aggregated DIRECTLY from disco_orders — the same
// source the Daily Revenue graph (app/api/restaurant/orders/route.ts) and the
// CSV/Excel/PDF exports use — since disco_orders mirrors BOTH FM-origin and
// native orders for every restaurant and is never missing a row.
//
// Tax/lead-gen/delivery-split/tips-split/stripe-fee are LEFT JOINed from
// disco_sale_transactions, now backfilled from fm_backup for FM-mirrored
// orders (previously this JOIN was an INNER JOIN against a table populated
// only by native checkout — 21 rows platform-wide against 21,264 real orders —
// which silently dropped every FM-mirrored order and produced Net Sales $1.00
// / 1 order for a restaurant with 318+ real orders; LEFT JOIN + separate
// disco_orders aggregates fixed that). Orders with genuinely no transaction
// row (the ~1,057 post-freeze orders with no fm_backup source, and any order
// placed before this backfill's cutoff — see the FM order-detail backfill
// report) are simply absent from these sums, same as any real revenue report
// with incomplete detail for a known subset of orders.
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
  // Created Date mode needs the restaurant's OWN local date, not the UTC date —
  // `... AT TIME ZONE tz` converts the timestamptz to that zone's wall-clock
  // time before the ::date cast. And it needs the REAL placement date, not
  // Neon's sync timestamp: COALESCE(placed_at, created_at) — placed_at is FM's
  // real order-creation time (backfilled for pre-freeze orders, populated going
  // forward by the fixed sync); created_at is sync time, which for FM-mirrored
  // orders can trail real placement by hours to years. Before this, "Created
  // Date" mode for a restaurant with years of FM history showed its entire
  // revenue crammed into whichever 1-2 months the mirror job happened to run.
  // LEFT JOIN (not INNER — see the comment above) so an order with no
  // transaction row still counts toward the always-reliable 4 fields, just
  // contributes 0 to the transaction-derived sums below (COALESCE, never NULL
  // arithmetic). Only transaction_type='ORIGINAL' — matches the admin
  // dashboard's nativeSaleStats() convention (app/api/admin/dashboard/
  // sale-stats/route.ts) of excluding ADDITIONAL/REFUND rows so an edit or
  // refund isn't double-counted on top of the original sale.
  //
  // Neon's schema has one combined third-party bucket (own_delivery_fee vs
  // third_party_delivery_fee/tips — no separate DoorDash columns), so
  // "DoorDash" cards are populated only when this order's delivery_type is
  // literally DOORDASH; a Nash or other third-party order shows under the
  // generic Third-Party cards instead. Pickup vs Self-Delivery tips are split
  // by the SAME order's own delivery_type/order_type, since disco_sale_
  // transactions.tips_in_price doesn't carry that distinction itself.
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS "totalOrdersCount",
      COALESCE(SUM(o.subtotal), 0)::float8 AS "subtotalOrdersSum",
      COALESCE(AVG(o.subtotal), 0)::float8 AS "subtotalOrdersAvg",
      COALESCE(SUM(o.total), 0)::float8 AS "totalOrdersSum",
      COALESCE(SUM(st.state_tax), 0)::float8 AS "stateSalesTaxInPriceSum",
      COALESCE(SUM(st.local_tax), 0)::float8 AS "localSalesTaxInPriceSum",
      COALESCE(SUM(st.other_tax), 0)::float8 AS "otherSalesTaxInPriceSum",
      COALESCE(SUM(st.lead_gen_one_disco_fee), 0)::float8 AS "leadgenonediscofee",
      COALESCE(SUM(st.lead_gen_two_disco_fee), 0)::float8 AS "leadgentwodiscofee",
      COALESCE(SUM(st.service_charge), 0)::float8 AS "serviceChargesSum",
      COALESCE(SUM(st.stripe_fee), 0)::float8 AS "stripeFeeSum",
      COALESCE(SUM(st.own_delivery_fee), 0)::float8 AS "ownDeliveryPriceSum",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'DOORDASH' THEN st.third_party_delivery_fee ELSE 0 END), 0)::float8 AS "doordashDeliveryFeeSum",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'DOORDASH' THEN 0 ELSE st.third_party_delivery_fee END), 0)::float8 AS "thirdPartyDeliveryFeeSum",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'OWN_DELIVERY' THEN 0 ELSE st.tips_in_price END), 0)::float8 AS "pickupTipsInPrice",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'OWN_DELIVERY' THEN st.tips_in_price ELSE 0 END), 0)::float8 AS "owndeliveryTipsInPrice",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'DOORDASH' THEN st.third_party_delivery_tips ELSE 0 END), 0)::float8 AS "doordashTipsOrdersSum",
      COALESCE(SUM(CASE WHEN o.delivery_type = 'DOORDASH' THEN 0 ELSE st.third_party_delivery_tips END), 0)::float8 AS "thirdPartyDeliveryTipsOrdersSum"
    FROM disco_orders o
    LEFT JOIN disco_restaurant_cache rc ON rc.restaurant_reference = o.restaurant_reference::text
    LEFT JOIN disco_sale_transactions st ON st.order_id = o.id AND st.transaction_type = 'ORIGINAL'
    WHERE o.restaurant_reference = ANY(${refs}::uuid[])
      AND o.is_deleted = false
      AND o.order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
      AND (
        ${from}::date IS NULL OR
        (CASE WHEN ${byCreated}
           THEN (COALESCE(o.placed_at, o.created_at) AT TIME ZONE COALESCE(rc.timezone, ${RESTAURANT_TZ_DEFAULT}))::date
           ELSE o.order_date
         END) >= ${from}::date
      )
      AND (
        ${to}::date IS NULL OR
        (CASE WHEN ${byCreated}
           THEN (COALESCE(o.placed_at, o.created_at) AT TIME ZONE COALESCE(rc.timezone, ${RESTAURANT_TZ_DEFAULT}))::date
           ELSE o.order_date
         END) <= ${to}::date
      )
  `) as Record<string, unknown>[]

  return NextResponse.json(rows[0] || {})
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
