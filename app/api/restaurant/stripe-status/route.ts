import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ connected: false }) }
  const refParam = req.nextUrl.searchParams.get('ref')
  const ref = refParam || await getRestaurantRef()
  if (!ref) return NextResponse.json({ connected: false })
  try {
    const res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: h })
    return NextResponse.json({ connected: res.ok })
  } catch { return NextResponse.json({ connected: false }) }
}
