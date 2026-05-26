import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantToken } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const token = await getRestaurantToken()
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/restaurant/stats`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      // Stats endpoint may not exist — return null so UI can calculate from orders
      console.warn('FM stats endpoint returned:', res.status)
      return NextResponse.json(null, { status: 404 })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/stats GET error:', err)
    return NextResponse.json(null, { status: 500 })
  }
}
