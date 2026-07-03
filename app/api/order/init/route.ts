import { NextRequest, NextResponse } from 'next/server'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { fmFetch } from '../../../../lib/fm-fetch'
import { isDiscoNativeRestaurant, priceNativeCheckout } from '../../../../lib/order/native-checkout'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { restaurantRef, ...orderBody } = body
    if (!restaurantRef) return NextResponse.json({ error: 'restaurantRef required' }, { status: 400 })

    // ── Disco-native path: price the cart in Neon (zero FM). ──
    if (await isDiscoNativeRestaurant(restaurantRef)) {
      const b = await priceNativeCheckout({
        restaurantReference: restaurantRef,
        customerEmail: String(body?.customerEmail || body?.customer?.email || ''),
        fulfillment: body?.fulfillment || (body?.deliveryAddress ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'),
        items: Array.isArray(body?.items) ? body.items : [],
        tip: body?.tip,
        deliveryFee: body?.deliveryFee,
        discountPct: body?.discountPct,
        scPct: body?.scPct,
      })
      return NextResponse.json({ native: true, ...b })
    }

    // FM rejects formatted phone numbers — digits only. Sanitize any phone field
    // anywhere in the init body (customer / deliveryAddress) before forwarding.
    sanitizePhoneFields(orderBody)

    const res = await fmFetch(`${FM}/public-api/v2/restaurants/${restaurantRef}/orders/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(orderBody),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to init order' }, { status: 500 })
  }
}
