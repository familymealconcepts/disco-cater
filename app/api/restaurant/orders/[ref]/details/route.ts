import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Loads the full order details used to pre-populate the edit page.
// FM (per Revyrie spec): GET /public-api/v2/orders/{orderRef}/details
// Auth: the SUPER_ADMIN service JWT (raw, no "Bearer" prefix) — Disco-native
// users have no FM token, and a restaurant user's own token isn't authorized
// here. The endpoint is keyed only by orderRef.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Gate: require an authenticated restaurant user (Disco-native OR legacy FM).
  const ctx = await getRestaurantAuthContext()
  if (!ctx) {
    console.error('[orders/details] not authenticated — no restaurant session')
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (err) {
    console.error('[orders/details] service auth failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Service auth unavailable' }, { status: 500 })
  }

  const url = `${FM_BASE}/public-api/v2/orders/${ref}/details`

  try {
    const res = await fetch(url, {
      // Raw service JWT (no X-RESTAURANT-UUID — this endpoint is keyed by orderRef).
      headers: { ...auth, Accept: 'application/json' },
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
