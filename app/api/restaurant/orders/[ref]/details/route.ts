import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Loads the full order details used to pre-populate the edit page.
// FM (per Revyrie spec): GET /public-api/v2/orders/{orderRef}/details
// Auth: raw JWT in Authorization (no "Bearer" prefix) — getRestaurantAuthHeader.
// NOTE: the endpoint is keyed only by orderRef; restaurantRef is NOT part of
// the path or headers here.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    console.error('[orders/details] not authenticated — no restaurant token cookie')
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const url = `${FM_BASE}/public-api/v2/orders/${ref}/details`
  const token = authHeaders.Authorization || ''
  console.error('[orders/details] FM request', {
    orderRef: ref,
    url,
    hasAuth: !!token,
    authPrefix: token.slice(0, 12),
    authLooksLikeBearer: /^Bearer\s/i.test(token),
  })

  try {
    const res = await fetch(url, {
      // Raw JWT only (no X-RESTAURANT-UUID — this endpoint is keyed by orderRef).
      headers: { ...authHeaders, Accept: 'application/json' },
    })

    const text = await res.text()
    console.error('[orders/details] FM response', {
      orderRef: ref,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      bodyPreview: text.slice(0, 1500),
    })

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to load order details', fmStatus: res.status, fmBody: text.slice(0, 500) },
        { status: res.status }
      )
    }

    let data: unknown = {}
    try { data = text ? JSON.parse(text) : {} } catch {
      console.error('[orders/details] FM body was not valid JSON')
    }
    return NextResponse.json(data, { status: 200 })
  } catch (err) {
    console.error('[orders/details] fetch threw', err)
    return NextResponse.json({ error: 'Unable to load order details' }, { status: 500 })
  }
}
