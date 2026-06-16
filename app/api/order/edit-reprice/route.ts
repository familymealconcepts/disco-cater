import { NextRequest, NextResponse } from 'next/server'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'

// Thin authenticated proxy for the order-edit re-price. Forwards the current
// cart to FM's order-update endpoint using the SUPER_ADMIN service JWT (raw, no
// "Bearer " prefix) so FM computes authoritative tax/fees/delivery, and returns
// FM's checkoutPublicResponseDto as-is. Repricing only — not the final commit.
export async function POST(req: NextRequest) {
  try {
    const { restaurantRef, orderRef, payload } = await req.json()
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    let auth: Record<string, string>
    try {
      auth = await getFmServiceAuthHeader()
    } catch (err) {
      console.error('[order/edit-reprice] service auth failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Service auth unavailable' }, { status: 500 })
    }

    const url = `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })

    const text = await res.text()
    if (!res.ok) console.error('[order/edit-reprice] FM error:', res.status, text.slice(0, 500))
    // Pass FM's body straight back (JSON when parseable, else raw).
    try {
      return NextResponse.json(text ? JSON.parse(text) : {}, { status: res.status })
    } catch {
      return new NextResponse(text, { status: res.status, headers: { 'Content-Type': 'application/json' } })
    }
  } catch (err) {
    console.error('[order/edit-reprice] error:', err)
    return NextResponse.json({ error: 'Failed to reprice order' }, { status: 500 })
  }
}
