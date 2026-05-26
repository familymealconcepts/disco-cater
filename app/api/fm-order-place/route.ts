import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { restaurantRef, orderRef } = await req.json()
    if (!restaurantRef || !orderRef) return NextResponse.json({ error: 'Missing restaurantRef or orderRef' }, { status: 400 })

    const res = await fetch(
      `${FM}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: token },
      }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
