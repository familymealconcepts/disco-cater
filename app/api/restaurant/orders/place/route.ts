import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Restaurant-portal "Create Order" (Direct Entry) place endpoint.
// Same FM endpoint as the customer place flow (POST /api/v2/restaurants/{ref}/
// orders/{orderRef}) — FM's own admin Create Order uses this exact endpoint
// with the restaurant admin's JWT (see familymeal-platform jwt.interceptor +
// meal-package.service checkoutOrderV2). The ONLY difference from
// app/api/order/place is auth: restaurant token (cookie) instead of the
// customer token, so portal staff can place on behalf of a customer.
export async function POST(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { restaurantRef, orderRef, ...placeBody } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    const res = await fetch(`${FM}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(placeBody),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
