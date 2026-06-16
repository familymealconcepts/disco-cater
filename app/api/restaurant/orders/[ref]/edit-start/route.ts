import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRef } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Starts an edit session: creates the edit draft and acquires the edit lock.
// FM: POST /public-api/v2/restaurants/{restaurantRef}/orders/{orderRef}/slotselected?editOrder=true
// Auth: the SUPER_ADMIN service JWT (raw, no "Bearer" prefix) — a restaurant
// user's own token isn't authorized for this edit endpoint, and Disco-native
// users have no FM token at all.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Gate: require an authenticated restaurant user (Disco-native OR legacy FM).
  const ctx = await getRestaurantAuthContext()
  if (!ctx) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  // Restaurant ref: Disco sessions carry it; FM users resolve it from the token.
  const restaurantRef = ctx.restaurantReference || (await getRestaurantRef())
  if (!restaurantRef) {
    return NextResponse.json({ error: 'No restaurant reference' }, { status: 401 })
  }

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (err) {
    console.error('[orders/edit-start] service auth failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Service auth unavailable' }, { status: 500 })
  }

  try {
    const res = await fetch(
      `${FM_BASE}/public-api/v2/restaurants/${restaurantRef}/orders/${ref}/slotselected?editOrder=true`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      }
    )
    const data = await res.json().catch(() => ({}))
    // Log the raw FM slotselected payload so the edit-draft ref field is visible.
    console.log('[orders/edit-start] FM slotselected response:', res.status, JSON.stringify(data).slice(0, 1200))
    if (!res.ok) {
      return NextResponse.json({ error: data?.message || 'Could not start edit session' }, { status: res.status })
    }
    // Surface the lock duration (seconds) and the edit-draft ref under a stable
    // shape, while passing the raw payload through for anything else the client
    // needs. FM may nest the cloned edit order under data/order, so check both
    // levels and several field names.
    const inner = data?.data ?? data?.order ?? data
    const lockDuration =
      data?.lockDuration ?? data?.editLockDuration ?? data?.lockDurationSeconds ?? data?.lockTtl ??
      inner?.lockDuration ?? inner?.editLockDuration ?? null
    const editOrderRef =
      data?.editOrderRef ?? data?.editOrderReference ?? data?.editOrderId ?? data?.editReference ??
      data?.draftOrderReference ?? data?.draftReference ??
      inner?.editOrderRef ?? inner?.editOrderReference ?? inner?.orderReference ?? inner?.reference ??
      data?.orderReference ?? data?.reference ?? null
    return NextResponse.json({ lockDuration, editOrderRef, restaurantRef, ...data })
  } catch {
    return NextResponse.json({ error: 'Could not start edit session' }, { status: 500 })
  }
}
