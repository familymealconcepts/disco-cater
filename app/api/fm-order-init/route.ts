import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, ...rest } = body
    if (!restaurantRef) return NextResponse.json({ error: 'Missing restaurantRef' }, { status: 400 })

    const res = await fetch(
      `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/init`,
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
