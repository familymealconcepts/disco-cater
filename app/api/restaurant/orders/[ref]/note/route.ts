import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Saves an order note. FM: PUT /api/orders/{ref}/note (the public-api/v2 variant
// 404s — it doesn't exist). Auth: the SUPER_ADMIN service JWT (raw, no "Bearer"
// prefix) — Disco-native users have no FM token and a restaurant user's own
// token isn't authorized here. X-RESTAURANT-UUID carries the restaurant ref
// resolved from the auth context.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Gate: require an authenticated restaurant user (Disco-native OR legacy FM).
  const ctx = await getRestaurantAuthContext()
  if (!ctx) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (err) {
    console.error('[orders/note] service auth failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Service auth unavailable' }, { status: 500 })
  }

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/orders/${ref}/note`, {
      method: 'PUT',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RESTAURANT-UUID': ctx.restaurantReference,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      // Surface FM's actual error rather than a generic "Failed".
      const errorText = await res.text().catch(() => '')
      console.error('[orders/note] FM error', res.status, errorText.slice(0, 500))
      return NextResponse.json({ error: errorText || 'Failed to save note' }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('[orders/note] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to save note' }, { status: 500 })
  }
}
