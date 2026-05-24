import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { restaurantRef, orderRef } = await req.json()
    if (!restaurantRef || !orderRef) return NextResponse.json({ error: 'Missing restaurantRef or orderRef' }, { status: 400 })

    const res = await fetch(
      `https://api.familymeal.com/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
