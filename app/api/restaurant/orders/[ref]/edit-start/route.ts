import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../../lib/restaurant-auth'

const EDIT_FM_BASE = process.env.FAMILYMEAL_EDIT_API_BASE || process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Starts an edit session: creates the edit draft and acquires the edit lock.
// FM: POST /public-api/v2/restaurants/{restaurantRef}/orders/{orderRef}/slotselected?editOrder=true
// Returns the lock duration and (if FM clones the order) the draft edit ref.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const restaurantRef = await getRestaurantRef()
  if (!restaurantRef) {
    return NextResponse.json({ error: 'No restaurant reference' }, { status: 401 })
  }
  try {
    const res = await fetch(
      `${EDIT_FM_BASE}/public-api/v2/restaurants/${restaurantRef}/orders/${ref}/slotselected?editOrder=true`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json', Accept: 'application/json' },
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return NextResponse.json({ error: data?.message || 'Could not start edit session' }, { status: res.status })
    }
    // Surface the lock duration (seconds) and any returned edit-draft ref under
    // a stable shape, while passing the raw payload through for anything else
    // the client needs.
    const lockDuration =
      data?.lockDuration ?? data?.editLockDuration ?? data?.lockDurationSeconds ?? data?.lockTtl ?? null
    const editOrderRef =
      data?.editOrderRef ?? data?.editOrderReference ?? data?.orderReference ?? data?.reference ?? null
    return NextResponse.json({ lockDuration, editOrderRef, restaurantRef, ...data })
  } catch {
    return NextResponse.json({ error: 'Could not start edit session' }, { status: 500 })
  }
}
