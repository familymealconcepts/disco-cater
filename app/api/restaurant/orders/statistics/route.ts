import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ unseenByAdmin: 0 })
  }
  const ref = await getRestaurantRef()
  if (!ref) return NextResponse.json({ unseenByAdmin: 0 })
  try {
    const res = await fetch(`${FM}/api/orders/${ref}/statistics`, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ unseenByAdmin: 0 })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ unseenByAdmin: 0 })
  }
}
