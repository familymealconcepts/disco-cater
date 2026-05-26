import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/stripe/clients/${restaurantRef}/connect`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'callbackUri=https://familymeal.com/restaurant/account',
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to connect Stripe', raw: err }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to connect Stripe' }, { status: 500 })
  }
}
