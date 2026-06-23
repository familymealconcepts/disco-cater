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

    // FM requires orderType as "PICKUP" or "DELIVERY" — empty string causes 500.
    // Normalize here as a server-side backstop: anything that isn't exactly
    // "DELIVERY" becomes "PICKUP" so a missing/blank value can never 500 FM.
    updateBody.orderType = updateBody.orderType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'

    const url = `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`
    // DIAGNOSTIC: log the EXACT payload forwarded to FM (what FM actually parses).
    console.log('[order/update] → FM PUT', url, '\n  payload:', JSON.stringify(updateBody))
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(updateBody),
    })
    // Read the body as text first so a non-JSON FM error (HTML/plain 500) can't
    // throw on res.json() and mask the real cause as a generic proxy 500.
    const text = await res.text()
    // DIAGNOSTIC: log the EXACT FM response — status + raw body, not just the code.
    console.log('[order/update] ← FM', res.status, res.statusText, '\n  body:', text.slice(0, 2000))
    let data: unknown
    try { data = text ? JSON.parse(text) : {} } catch {
      // Surface FM's raw error body to the client + logs instead of swallowing it.
      data = { error: 'FM returned a non-JSON response', fmStatus: res.status, fmBody: text.slice(0, 1000) }
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
}
