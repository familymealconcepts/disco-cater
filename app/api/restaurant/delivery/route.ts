import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantToken } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  const token = await getRestaurantToken()
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const res = await fetch(`${FM}/api/restaurant/delivery`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      console.error('FM delivery GET error:', res.status, err)
      return NextResponse.json({ error: 'Failed to fetch delivery settings', raw: err }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/delivery GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch delivery settings' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const token = await getRestaurantToken()
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/restaurant/delivery`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update delivery settings', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/delivery PUT error:', err)
    return NextResponse.json({ error: 'Unable to update delivery settings' }, { status: 500 })
  }
}
