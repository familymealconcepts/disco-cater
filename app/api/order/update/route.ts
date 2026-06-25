import { NextRequest, NextResponse } from 'next/server'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Forwards the order re-price to FM. FM's order-update PUT returns
// UNKNOWN_SERVER_ERROR when it receives any non-standard field, so instead of
// blacklisting known-bad fields we WHITELIST only the standard checkout-DTO
// fields and drop everything else. Notably this strips taxExempt / taxExemptId /
// taxExemptState (tax exemption is a customer-account concern in FM, not
// per-order — reflected client-side in the UI) and any other extras the client
// may add (headcount, paymentMethod, sourceoforder, …).
const FM_UPDATE_ALLOWED_FIELDS = [
  'restaurantReference', 'items', 'mealPackages', 'orderType', 'orderDate', 'orderTime',
  'tips', 'tipsType', 'couponCode', 'deliveryAddress', 'persons', 'subtotal', 'total', 'fee',
] as const

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, orderRef } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    // Whitelist: keep only FM's standard checkout-DTO fields; drop everything else.
    const updateBody: Record<string, unknown> = {}
    for (const k of FM_UPDATE_ALLOWED_FIELDS) {
      if (body[k] !== undefined) updateBody[k] = body[k]
    }

    // FM requires orderType as "PICKUP" or "DELIVERY" — empty string causes 500.
    // Normalize as a server-side backstop so a missing/blank value can never 500.
    updateBody.orderType = updateBody.orderType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'

    const url = `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(updateBody),
    })
    // Read the body as text first so a non-JSON FM error (HTML/plain 500) can't
    // throw on res.json() and mask the real cause as a generic proxy 500.
    const text = await res.text()
    if (!res.ok) console.error('[order/update] FM error', res.status, text.slice(0, 300))
    let data: unknown
    try { data = text ? JSON.parse(text) : {} } catch {
      data = { error: 'FM returned a non-JSON response', fmStatus: res.status, fmBody: text.slice(0, 1000) }
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
}
