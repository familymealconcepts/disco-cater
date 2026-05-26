import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function DELETE() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/stripe/disconnect/${restaurantRef}`, { headers: h })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to disconnect Stripe', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to disconnect Stripe' }, { status: 500 })
  }
}
