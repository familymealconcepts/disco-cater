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
  const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value
  const isSystemAdminAggregate = (role === 'SYSTEM_ADMIN' || role === 'SUPER_ADMIN') && !selected

  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  if (searchParams.get('fromDate')) params.set('fromDate', searchParams.get('fromDate')!)
  if (searchParams.get('toDate')) params.set('toDate', searchParams.get('toDate')!)
  if (searchParams.get('dateType')) params.set('dateType', searchParams.get('dateType')!)

  // ADMIN: FM's filterSaleStats() in admin-manager/.../dashboard.component
  // does not pass restaurantReference, but FM's
  // dashboard-restaurant.component does include it when scoped to one
  // location. Without an explicit restaurantReference param the per-
  // restaurant ADMIN call was returning empty stats on the deployed FM,
  // so we forward the JWT-derived ref here. SA with a selection keeps
  // its existing behavior (the FM session has the picked restaurant).
  if (role === 'ADMIN' || role === 'RESTAURANT_USER' || role === 'RESTAURANT_ADMIN') {
    const ref = await getRestaurantRef()
    if (ref) params.set('restaurantReference', ref)
  }

  const url = isSystemAdminAggregate
    ? `${FM}/api/system-admin/dashboard/sale/stats?${params}`
    : `${FM}/api/dashboard/sale/stats?${params}`
  try {
    const res = await fetch(url, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch sale stats' }, { status: 500 })
  }
}
