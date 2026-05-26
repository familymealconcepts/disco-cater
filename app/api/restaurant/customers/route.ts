import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const sp = req.nextUrl.searchParams
    const params = new URLSearchParams()
    if (sp.get('page')) params.set('page', sp.get('page')!)
    if (sp.get('size')) params.set('size', sp.get('size')!)
    if (sp.get('sort')) params.set('sort', sp.get('sort')!)
    if (sp.get('search')) params.set('search', sp.get('search')!)
    params.set('restaurantReference', restaurantRef)

    const res = await fetch(`${FM}/api/customer/users?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch customers' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch customers' }, { status: 500 })
  }
}
