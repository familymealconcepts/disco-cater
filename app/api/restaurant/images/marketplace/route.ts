import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const formData = await req.formData()
    const res = await fetch(`${FM}/api/images/${restaurantRef}/marketplace`, {
      method: 'POST',
      headers: h,
      body: formData,
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to upload marketplace image', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to upload marketplace image' }, { status: 500 })
  }
}
