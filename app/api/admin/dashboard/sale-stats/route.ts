import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// FM's dashboard filters by DD.MM.YYYY (see the same note in
// app/api/restaurant/dashboard/sale-stats/route.ts); the Neon query below needs ISO.
function toIso(s: string | null): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

const n = (v: unknown): number => Number(v) || 0

// Disco-native orders never reach FM, so FM's own sale/stats response is
// structurally blind to them. Aggregate the same window/scope from Neon — same
// query shape as the restaurant portal's discoSaleStats()
// (app/api/restaurant/dashboard/sale-stats/route.ts:50-76): only ORIGINAL
// transactions (excludes REFUND/ADDITIONAL rows so an edit or refund isn't
// double-counted on top of the original sale) on settled/payable orders.
// Unlike the restaurant portal (which is always scoped to one restaurant or
// group), the admin dashboard aggregates across ALL native restaurants when no
// restaurantReference is selected — this is a platform-wide view, not a
// per-restaurant one.
async function nativeSaleStats(fromIso: string | null, toIso_: string | null, restaurantRef: string | null) {
  await runDiscoOrderMigrations()
  const scopedRef = restaurantRef && UUID_RE.test(restaurantRef) ? restaurantRef : null
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS "totalOrdersCount",
      COALESCE(SUM(st.subtotal), 0)::float8 AS "subtotalOrdersSum",
      COALESCE(SUM(st.fee), 0)::float8 AS "feeSum",
      COALESCE(SUM(st.stripe_fee), 0)::float8 AS "stripeFeeSum",
      COALESCE(SUM(st.state_tax), 0)::float8 AS "stateSalesTaxInPriceSum",
      COALESCE(SUM(st.local_tax), 0)::float8 AS "localSalesTaxInPriceSum",
      COALESCE(SUM(st.other_tax), 0)::float8 AS "otherSalesTaxInPriceSum",
      COALESCE(SUM(st.tips_in_price), 0)::float8 AS "tipsInPrice",
      COALESCE(SUM(st.own_delivery_fee), 0)::float8 AS "ownDeliveryPriceSum",
      COALESCE(SUM(st.third_party_delivery_tips), 0)::float8 AS "thirdPartyTipsOrdersSum",
      COALESCE(SUM(st.third_party_delivery_fee), 0)::float8 AS "thirdPartyDeliveryFeeSum",
      COALESCE(SUM(st.service_charge), 0)::float8 AS "serviceChargesSum"
    FROM disco_sale_transactions st
    JOIN disco_orders o ON o.id = st.order_id
    WHERE st.transaction_type = 'ORIGINAL'
      AND o.order_status IN ('DUE','COMPLETED','PAID','PARTIAL_REFUND','REFUND')
      AND (${scopedRef}::uuid IS NULL OR o.restaurant_reference = ${scopedRef}::uuid)
      AND (${fromIso}::date IS NULL OR o.order_date >= ${fromIso}::date)
      AND (${toIso_}::date IS NULL OR o.order_date <= ${toIso_}::date)
  `.catch(() => [])) as Record<string, number>[]
  return rows[0] || {}
}

// GET /api/admin/dashboard/sale/stats?fromDate=&toDate=&restaurantReference=
// Per docs/fm-super-admin-audit.md § D.6, FM's canonical SA endpoint is
// /sale/stats (the /statistics variant was a wrong guess earlier).
export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const fromDate = sp.get('fromDate')
  const toDate = sp.get('toDate')
  const restaurantReference = sp.get('restaurantReference')
  const params = new URLSearchParams()
  if (fromDate) params.set('fromDate', fromDate)
  if (toDate) params.set('toDate', toDate)
  if (restaurantReference) params.set('restaurantReference', restaurantReference)

  let data: Record<string, unknown>
  try {
    const res = await fetch(`${FM}/api/admin/dashboard/sale/stats?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch sale stats' }, { status: res.status })
    data = await res.json()
  } catch {
    return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
  }

  // Platform Fees: FM's own real-vs-estimated logic is computed from FM's data
  // ALONE (unchanged from before) — native orders always carry a real per-order
  // fee (disco_sale_transactions.fee), so they're added on top unconditionally
  // rather than folded into FM's estimate-or-not decision.
  const fmRealFee = Number(data.feeSum)
  const hasFmRealFee = Number.isFinite(fmRealFee) && fmRealFee > 0
  const fmPlatformFees = hasFmRealFee ? fmRealFee : n(data.subtotalOrdersSum) * 0.03

  const native = await nativeSaleStats(toIso(fromDate), toIso(toDate), restaurantReference)

  // FM's actual field for third-party tips is `thirdPartyDeliveryTipsOrdersSum`
  // — confirmed by diffing FM's raw response directly; both `thirdPartyTipsOrdersSum`
  // and the older `doordashTipsOrdersSum` come back undefined from the live
  // endpoint, which meant the Third-Party Tips card silently showed $0
  // regardless of real activity. Kept as fallbacks in case FM's shape changes
  // again, but the confirmed-correct field now takes priority. Delivery FEE
  // (as opposed to tips) already came through correctly under
  // `thirdPartyDeliveryFeeSum`, so that one is untouched.
  const fmThirdPartyTips = n(data.thirdPartyDeliveryTipsOrdersSum ?? data.thirdPartyTipsOrdersSum ?? data.doordashTipsOrdersSum)
  const fmThirdPartyDelivery = n(data.thirdPartyDeliveryFeeSum ?? data.doordashDeliveryFeeSum)

  return NextResponse.json({
    ...data,
    totalOrdersCount: n(data.totalOrdersCount) + n(native.totalOrdersCount),
    subtotalOrdersSum: n(data.subtotalOrdersSum) + n(native.subtotalOrdersSum),
    stateSalesTaxInPriceSum: n(data.stateSalesTaxInPriceSum) + n(native.stateSalesTaxInPriceSum),
    localSalesTaxInPriceSum: n(data.localSalesTaxInPriceSum) + n(native.localSalesTaxInPriceSum),
    otherSalesTaxInPriceSum: n(data.otherSalesTaxInPriceSum) + n(native.otherSalesTaxInPriceSum),
    tipsInPrice: n(data.tipsInPrice) + n(native.tipsInPrice),
    ownDeliveryPriceSum: n(data.ownDeliveryPriceSum) + n(native.ownDeliveryPriceSum),
    thirdPartyTipsOrdersSum: fmThirdPartyTips + n(native.thirdPartyTipsOrdersSum),
    thirdPartyDeliveryFeeSum: fmThirdPartyDelivery + n(native.thirdPartyDeliveryFeeSum),
    serviceChargesSum: n(data.serviceChargesSum) + n(native.serviceChargesSum),
    stripeFeeSum: n(data.stripeFeeSum) + n(native.stripeFeeSum),
    platformFees: fmPlatformFees + n(native.feeSum),
    platformFeesEstimated: !hasFmRealFee,
  })
}
