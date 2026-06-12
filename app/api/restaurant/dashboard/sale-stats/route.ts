import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../../lib/restaurant-auth-context'
import { cookies } from 'next/headers'
import { SELECTED_RESTAURANT_COOKIE } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

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

  // Disco-only users → SUPER_ADMIN sale stats scoped by restaurantReference. The
  // DashboardSaleStatisticsResponseDto field names already match the page's
  // SaleStats shape, so no remapping is needed — just the FM date format.
  if (usesServiceAccount(ctx)) {
    const sp = req.nextUrl.searchParams
    const p = new URLSearchParams()
    const from = toFmDate(sp.get('fromDate'))
    const to = toFmDate(sp.get('toDate'))
    if (from) p.set('fromDate', from)
    if (to) p.set('toDate', to)
    if (sp.get('dateType')) p.set('dateType', sp.get('dateType')!)
    p.set('restaurantReference', ctx.restaurantReference)
    try {
      const headers = await getFmHeaderForRestaurant(ctx)
      const res = await fetch(`${FM}/api/admin/dashboard/sale/stats?${p}`, { headers })
      if (!res.ok) return NextResponse.json({ error: 'Failed', fmStatus: res.status }, { status: res.status })
      return NextResponse.json(await res.json())
    } catch {
      return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
    }
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
