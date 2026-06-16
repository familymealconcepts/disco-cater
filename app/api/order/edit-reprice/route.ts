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

    // FM's edit PUT only wants the cart as mealPackages [{reference,count}]; the
    // full `items`/`extraItems` objects 500 it. Strip them here too so this
    // endpoint can never forward them (the regular /api/order/update is untouched).
    const fmPayload: Record<string, unknown> = { ...(payload ?? {}) }
    delete fmPayload.items
    delete fmPayload.extraItems

    const url = `${FM}/public-api/v2/restaurants/${restaurantRef}/orders/${orderRef}`
    const fmResponse = await fetch(url, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(fmPayload),
    })

    if (!fmResponse.ok) {
      // Surface FM's exact rejection so the failing field is visible in the
      // Network tab + server logs (it's otherwise opaque on a 500).
      const errorText = await fmResponse.text()
      console.error('[edit-reprice] FM error', fmResponse.status, errorText)
      return NextResponse.json({ error: errorText }, { status: fmResponse.status })
    }

    // OK — FM nests the totals (and may wrap under `data`), so unpack the
    // checkoutPublicResponseDto from whichever shape FM returns and always hand
    // the client a flat { checkoutPublicResponseDto }.
    const text = await fmResponse.text()
    let body: Record<string, unknown> = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      console.error('[edit-reprice] FM body was not valid JSON')
    }
    console.log('[edit-reprice] FM response body:', JSON.stringify(body).slice(0, 500))

    const b = body as {
      data?: { checkoutPublicResponseDto?: unknown }
      checkoutPublicResponseDto?: unknown
      subtotal?: unknown
    }
    let dto: unknown
    if (b.data?.checkoutPublicResponseDto !== undefined) dto = b.data.checkoutPublicResponseDto
    else if (b.checkoutPublicResponseDto !== undefined) dto = b.checkoutPublicResponseDto
    else if (b.subtotal !== undefined) dto = body
    else {
      console.warn('[edit-reprice] unrecognized FM response shape — returning body as-is')
      dto = body
    }

    return NextResponse.json({ checkoutPublicResponseDto: dto })
  } catch (err) {
    console.error('[order/edit-reprice] error:', err)
    return NextResponse.json({ error: 'Failed to reprice order' }, { status: 500 })
  }
}
