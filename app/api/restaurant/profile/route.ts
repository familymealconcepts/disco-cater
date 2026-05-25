import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantToken } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const token = getRestaurantToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    // ADMIN user profile — includes restaurant details
    const res = await fetch(`${FM}/api/users`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch profile' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/profile GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const token = getRestaurantToken(req)
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/restaurant/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update profile', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/profile PUT error:', err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
