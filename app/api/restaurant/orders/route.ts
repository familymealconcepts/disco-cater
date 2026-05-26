import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantToken } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// GET /api/restaurant/orders?status=&page=&size=&search=
export async function GET(req: NextRequest) {
  const token = await getRestaurantToken()
  if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const status = searchParams.get('status') || ''
  const page = searchParams.get('page') || '0'
  const size = searchParams.get('size') || '20'
  const search = searchParams.get('search') || ''

  try {
    const params = new URLSearchParams({ page, size })
    if (status) params.set('status', status)
    if (search) params.set('search', search)

    const res = await fetch(`${FM}/api/orders?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      console.error('FM orders error:', res.status, err)
      return NextResponse.json({ error: 'Failed to fetch orders', status: res.status, raw: err }, { status: res.status })
    }

    return NextResponse.json(await res.json())
  } catch (err) {
    console.error('restaurant/orders GET error:', err)
    return NextResponse.json({ error: 'Unable to fetch orders' }, { status: 500 })
  }
}
