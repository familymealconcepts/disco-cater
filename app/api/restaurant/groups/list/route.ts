import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

async function auth() { return getRestaurantAuthHeader() }

export async function GET(_req: NextRequest) {
  let h: Record<string, string>
  try { h = await auth() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'No restaurant reference' }, { status: 401 })
  try {
    const res = await fetch(
      `${FM}/api/restaurants/${restaurantRef}/extraItemsGroups?page=0&size=100`,
      { headers: h }
    )
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch groups' }, { status: 500 }) }
}
