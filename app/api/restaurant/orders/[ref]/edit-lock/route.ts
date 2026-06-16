import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Releases the edit lock when an edit session is committed, discarded, or
// abandoned (tab close / navigate away). Best-effort — always reports success
// to the caller so an abandon path never blocks navigation.
// FM: DELETE /public-api/v2/orders/{orderRef}/edit-lock
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    // Already unauthenticated — nothing to release.
    return NextResponse.json({ success: true })
  }
  try {
    await fetch(`${FM_BASE}/public-api/v2/orders/${ref}/edit-lock`, {
      method: 'DELETE',
      headers: { ...authHeaders, Accept: 'application/json' },
    })
  } catch {
    // swallow — releasing the lock is best-effort
  }
  return NextResponse.json({ success: true })
}
