import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Forwards the order update/re-price to FM, including the optional
// taxExempt / taxExemptId / taxExemptState fields. FM zeroes tax server-side
// when taxExempt=true (checkout-sidebar-preview.component.ts:320-325).
// TODO(tax-exempt verification): the exempt ID is currently accepted as-entered
// (no external check, per product decision). Future verification against a
// tax-authority API can be added HERE in the proxy with no UI change — validate
// before forwarding and reject/flag invalid IDs.
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, orderRef, ...updateBody } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    // Temporary diagnostic for the PUT 500 — this is the exact body FM receives
    // (restaurantRef/orderRef are stripped into the URL above). Check Vercel logs.
    console.log('[update] payload →' + JSON.stringify(updateBody, null, 2))

    const res = await fetch(`${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(updateBody),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
}
