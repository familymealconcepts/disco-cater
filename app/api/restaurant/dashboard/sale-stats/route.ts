import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { cookies } from 'next/headers'
import { SELECTED_RESTAURANT_COOKIE } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const role = await getRestaurantRole()
  const store = await cookies()
  const cookieRef = store.get(SELECTED_RESTAURANT_COOKIE)?.value

  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  if (searchParams.get('fromDate')) params.set('fromDate', searchParams.get('fromDate')!)
  if (searchParams.get('toDate')) params.set('toDate', searchParams.get('toDate')!)
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

  // SA / SUPER_ADMIN with no restaurant resolved → aggregate "all
  // restaurants" endpoint. Otherwise hit the per-restaurant endpoint
  // (the explicit restaurantReference param scopes it correctly).
  const isMultiRole = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'
  const isAggregate = isMultiRole && !scopedRef
  const url = isAggregate
    ? `${FM}/api/system-admin/dashboard/sale/stats?${params}`
    : `${FM}/api/dashboard/sale/stats?${params}`
  // Diagnostic: surface the proxy's routing decision in Vercel function
  // logs while we triage SUPER_ADMIN reporting. role + which ref source
  // won + the actual FM URL.
  // eslint-disable-next-line no-console
  console.log('[proxy:sale-stats]', {
    role,
    queryRef: queryRef || null,
    cookieRef: cookieRef || null,
    scopedRef: scopedRef || null,
    isAggregate,
    url,
  })
  try {
    const res = await fetch(url, { headers: authHeaders })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      // eslint-disable-next-line no-console
      console.warn('[proxy:sale-stats] FM error', res.status, raw.slice(0, 400))
      return NextResponse.json({ error: 'Failed', fmStatus: res.status }, { status: res.status })
    }
    const data = await res.json()
    // eslint-disable-next-line no-console
    console.log('[proxy:sale-stats] FM ok', {
      totalOrdersCount: data?.totalOrdersCount,
      totalOrdersSum: data?.totalOrdersSum,
      subtotalOrdersSum: data?.subtotalOrdersSum,
    })
    return NextResponse.json(data)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[proxy:sale-stats] fetch failed', e)
    return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
  }
}
