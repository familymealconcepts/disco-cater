import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Restaurant-portal "Create Order" payment confirmation. Mirrors
// app/api/order/confirm-payment but authenticates with the restaurant token
// (cookie) instead of the customer token, hitting the same FM endpoint
// (POST /api/userOrder/confirmPayment) that FM's admin checkout uses.
//
// NOTE: the Create Order "Payment Method" path is not yet wired end-to-end —
// it is gated pending confirmation that FM authorizes a RESTAURANT JWT on the
// userOrder/confirmPayment endpoint (it works in FM's single-JWT SPA, but
// disco-cater has separate customer vs restaurant tokens). The Invoice path
// never calls this route. This handler is in place so the payment path can be
// switched on once that's confirmed, with no further server work.
export async function POST(req: NextRequest) {
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/userOrder/confirmPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 })
  }
}
