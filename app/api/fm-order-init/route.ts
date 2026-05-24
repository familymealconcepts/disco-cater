import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, ...rest } = body
    if (!restaurantRef) return NextResponse.json({ error: 'Missing restaurantRef' }, { status: 400 })

    const res = await fetch(
      `https://api.familymeal.com/public-api/v2/restaurants/${restaurantRef}/orders/init`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(rest),
      }
    )
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to init order' }, { status: 500 })
  }
}
