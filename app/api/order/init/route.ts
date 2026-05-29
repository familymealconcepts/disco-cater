import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, ...orderBody } = body
    if (!restaurantRef) return NextResponse.json({ error: 'restaurantRef required' }, { status: 400 })

    const res = await fetch(`${FM}/public-api/v2/restaurants/${restaurantRef}/orders/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(orderBody),
    })
    const data = await res.json()
    // Temporary diagnostic for the init→update 500 — logs FM's actual status +
    // body so we can confirm success and the real data.orderReference. Vercel logs.
    console.log('[init] response →' + JSON.stringify({ status: res.status, data }, null, 2))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to init order' }, { status: 500 })
  }
}
