import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'
import { cookies } from 'next/headers'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// FM's SUPER_ADMIN "orders by restaurant" endpoint returns OrderPublicResponseDto,
// which names a few list fields differently than the OrderInfoResponseDto the
// portal orders table/chart expect. Map the differing keys (passing the rest
// through). Only used in the Disco branch — the FM path is untouched.
function normalizeAdminOrder(o: Record<string, unknown>): Record<string, unknown> {
  return {
    ...o,
    orderReference: o.reference ?? o.orderReference,
    transactionsTotal: o.total ?? o.transactionsTotal,
    orderSeenByAdmin: o.seenByAdmin ?? o.orderSeenByAdmin,
    orderCreatedDate: o.createdDate ?? o.orderCreatedDate,
    // Not present on the admin DTO; the status-change UI lives in the detail
    // route, so an empty list is correct for the list view.
    orderStatusesToChange: Array.isArray(o.orderStatusesToChange) ? o.orderStatusesToChange : [],
  }
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Disco-only users (no FM token) → SUPER_ADMIN "orders by restaurant" endpoint
  // scoped to their restaurantReference. FM users fall through to the original
  // role/cookie-scoped logic below, unchanged.
  if (usesServiceAccount(ctx)) {
    const sp = req.nextUrl.searchParams
    const params = new URLSearchParams()
    params.set('page', sp.get('page') || '0')
    params.set('size', sp.get('size') || '25')
    sp.getAll('sort').forEach(s => params.append('sort', s))
    try {
      const headers = await getFmHeaderForRestaurant(ctx)
      const res = await fetch(`${FM}/api/admin/restaurants/${ctx.restaurantReference}/orders?${params}`, { headers })
      if (!res.ok) {
        const err = await res.text()
        return NextResponse.json({ error: 'Failed to fetch orders', raw: err }, { status: res.status })
      }
      const data = await res.json()
      const content = Array.isArray(data?.content) ? data.content.map(normalizeAdminOrder) : []
      return NextResponse.json({ ...data, content })
    } catch (err) {
      console.error('restaurant/orders GET (disco) error:', err)
      return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
    }
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  params.set('page', sp.get('page') || '0')
  params.set('size', sp.get('size') || '25')
  sp.getAll('orderStatuses').forEach(s => params.append('orderStatuses', s))
  sp.getAll('sort').forEach(s => params.append('sort', s))
  if (sp.get('search')) params.set('search', sp.get('search')!)
  if (sp.get('fromDate')) params.set('fromDate', sp.get('fromDate')!)
  if (sp.get('toDate')) params.set('toDate', sp.get('toDate')!)
  const queryRef = sp.get('restaurantReference') || ''
  const role = await getRestaurantRole()
  const store = await cookies()
  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  const isSA = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'

  // Scope the orders to ONE location so the list/count never leak across
  // locations. Pick the restaurantReference to filter by:
  //   - an explicit ?restaurantReference (Reporting chart) always wins
  //   - SA who selected a location (fm_selected_restaurant cookie) → that one
  //   - ADMIN (single location) → their own restaurant from the JWT
  //   - SA with NO location selected → none (intentional all-locations view)
  let scopeRef = queryRef
  if (!scopeRef && isSA && selected) scopeRef = selected
  if (!scopeRef && !isSA) scopeRef = (await getRestaurantRef()) || ''
  if (scopeRef) params.set('restaurantReference', scopeRef)

  // SA must use FM's system-admin orders endpoint, which honors
  // restaurantReference (and aggregates across all locations when none is set).
  // The previous code routed a SA-with-selection through /api/orders, which is
  // scoped only by the JWT and therefore returned ALL of the SA's locations —
  // that was the leak. ADMIN keeps /api/orders (JWT carries its one restaurant);
  // we still pass restaurantReference above for explicit single-location scope.
  const useSystemAdmin = isSA
  const url = useSystemAdmin
    ? `${FM}/api/system-admin/orders?${params}`
    : `${FM}/api/orders?${params}`

  try {
    const res = await fetch(url, { headers: authHeaders })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to fetch orders', raw: err }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/orders GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
