import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRole, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../lib/restaurant-auth-context'
import { cookies } from 'next/headers'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

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
      return NextResponse.json(await res.json())
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
  // Explicit restaurant scope (Reporting chart). Mirrors the sale-stats proxy:
  // a SYSTEM_ADMIN/SUPER_ADMIN passes restaurantReference to scope the
  // system-admin endpoint to one location. Additive — the orders page never
  // sends this param, so its cookie/role scoping is unchanged.
  const queryRef = sp.get('restaurantReference') || ''
  if (queryRef) params.set('restaurantReference', queryRef)

  // Track 1 — SYSTEM_ADMIN multi-location orders. Per FM
  // admin-manager-orders (getOrdersBySystem → GET /api/system-admin/orders,
  // order.service.ts:163-182), a SA with no restaurant scoped sees orders
  // AGGREGATED across all assigned locations, NO restaurantReference param
  // (FM auto-filters by JWT). A SA who picked a location (fm_selected_
  // restaurant cookie) gets FM's session-scoped /api/orders for that one.
  // ADMIN always uses /api/orders (JWT carries its single restaurant).
  // Additive: only the previously-empty SA-no-selection case changes
  // endpoint; ADMIN and SA-selected paths are untouched.
  const role = await getRestaurantRole()
  const store = await cookies()
  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  const isSA = role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN'
  // SA uses the system-admin orders endpoint when scoping by an explicit
  // restaurantReference (Reporting chart, scoped to one location) OR when no
  // location is selected (aggregate across all locations). A SA who selected a
  // location via the cookie (orders page) keeps the session-scoped /api/orders
  // path. ADMIN always uses /api/orders (JWT carries its single restaurant).
  const useSystemAdmin = isSA && (queryRef !== '' || !selected)
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
