import { NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const authHeaders = await getFmHeaderForRestaurant(ctx)

  // FM's /api/dashboard/stats requires an ADMIN/SYSTEM_ADMIN token, which the
  // service account isn't — so Disco-only users hit the SUPER_ADMIN dashboard
  // scoped by restaurantReference instead. (Different DTO; the dashboard page may
  // need to adapt for Disco accounts.)
  const url = usesServiceAccount(ctx)
    ? `${FM}/api/admin/dashboard/sale/stats?restaurantReference=${encodeURIComponent(ctx.restaurantReference)}`
    : `${FM}/api/dashboard/stats`

  try {
    const res = await fetch(url, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
