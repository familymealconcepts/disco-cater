import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Releases the edit lock when an edit session is committed, discarded, or
// abandoned (tab close / navigate away). Best-effort — always reports success
// to the caller so an abandon path never blocks navigation.
// FM: DELETE /public-api/v2/orders/{orderRef}/edit-lock
// Auth: the SUPER_ADMIN service JWT (raw, no "Bearer" prefix) — Disco-native
// users have no FM token and a restaurant user's own token isn't authorized.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // No authenticated restaurant session → nothing to release.
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ success: true })

  // Ownership: never release another restaurant's edit lock. Return the same
  // best-effort success shape rather than 404 (no state change happens).
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ success: true })

  try {
    const auth = await getFmServiceAuthHeader()
    await fetch(`${FM_BASE}/public-api/v2/orders/${ref}/edit-lock`, {
      method: 'DELETE',
      headers: { ...auth, Accept: 'application/json' },
    })
  } catch {
    // swallow — releasing the lock is best-effort
  }
  return NextResponse.json({ success: true })
}
