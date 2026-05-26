import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/restaurants/taxRate`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch tax rate' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch tax rate' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/restaurants/taxRate`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update tax rate', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update tax rate' }, { status: 500 })
  }
}
