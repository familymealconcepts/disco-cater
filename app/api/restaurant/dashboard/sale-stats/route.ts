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

// Financial cards for a Disco-native restaurant — aggregated from Neon
// (disco_sale_transactions + disco_orders), not FM. Field names match the page's
// SaleStats shape (subtotalOrdersSum, stateSalesTaxInPriceSum, leadgenonediscofee, …).
async function discoSaleStats(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>, req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const from = toIso(sp.get('fromDate'))
  const to = toIso(sp.get('toDate'))
  const byCreated = sp.get('dateType') === 'createdDate'
  const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'

  // Scope: an explicit in-group location wins; else an SA sees their whole group
  // ("All restaurants"), and a single-location admin sees their own.
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
  // Only paid/settled orders; one ORIGINAL transaction per order (edits excluded to
  // avoid double-counting). tips_in_price is restaurant-kept (pickup/own delivery);
  // third_party_delivery_tips route to Disco.
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS "totalOrdersCount",
      COALESCE(SUM(st.subtotal), 0)::float8 AS "subtotalOrdersSum",
      COALESCE(AVG(st.subtotal), 0)::float8 AS "subtotalOrdersAvg",
      COALESCE(SUM(st.total), 0)::float8 AS "totalOrdersSum",
      COALESCE(SUM(st.state_tax), 0)::float8 AS "stateSalesTaxInPriceSum",
      COALESCE(SUM(st.local_tax), 0)::float8 AS "localSalesTaxInPriceSum",
      COALESCE(SUM(st.other_tax), 0)::float8 AS "otherSalesTaxInPriceSum",
      COALESCE(SUM(st.lead_gen_one_disco_fee), 0)::float8 AS "leadgenonediscofee",
      COALESCE(SUM(st.lead_gen_two_disco_fee), 0)::float8 AS "leadgentwodiscofee",
      COALESCE(SUM(st.service_charge), 0)::float8 AS "serviceChargesSum",
      COALESCE(SUM(st.stripe_fee), 0)::float8 AS "stripeFeeSum",
      COALESCE(SUM(st.own_delivery_fee), 0)::float8 AS "ownDeliveryPriceSum",
      COALESCE(SUM(st.third_party_delivery_tips), 0)::float8 AS "thirdPartyDeliveryTipsOrdersSum",
      COALESCE(SUM(st.tips_in_price) FILTER (WHERE o.order_type = 'PICKUP'), 0)::float8 AS "pickupTipsInPrice",
      COALESCE(SUM(st.tips_in_price) FILTER (WHERE o.delivery_type = 'OWN_DELIVERY'), 0)::float8 AS "owndeliveryTipsInPrice",
      0::float8 AS "doordashTipsOrdersSum",
      0::float8 AS "doordashDeliveryFeeSum"
    FROM disco_sale_transactions st
    JOIN disco_orders o ON o.id = st.order_id
    WHERE o.restaurant_reference = ANY(${refs}::uuid[])
      AND st.transaction_type = 'ORIGINAL'
      AND o.order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
      AND (${from}::date IS NULL OR (CASE WHEN ${byCreated} THEN o.created_at::date ELSE o.order_date END) >= ${from}::date)
      AND (${to}::date IS NULL OR (CASE WHEN ${byCreated} THEN o.created_at::date ELSE o.order_date END) <= ${to}::date)
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
