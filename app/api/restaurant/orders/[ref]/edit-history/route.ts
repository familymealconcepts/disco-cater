import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Returns the edit history for an order. FM doesn't (yet) expose a dedicated
// edit-history endpoint, so we pull the full order details and surface any
// edit-history-shaped array we can find. The exact wire shape is unconfirmed,
// so when we can't recognize it we return the raw payload for inspection.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM_BASE}/public-api/v2/orders/${ref}/details`, {
      headers: { ...authHeaders, Accept: 'application/json' },
    })
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to load order details' }, { status: res.status })
    }
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}

    // Look for an edit-history-shaped array under any of the likely keys.
    const history =
      data?.editHistory ??
      data?.editHistories ??
      data?.edits ??
      data?.orderEditHistory ??
      data?.history ??
      null

    if (Array.isArray(history)) {
      return NextResponse.json({ history })
    }
    // Shape unclear — return the raw payload so we can inspect it.
    return NextResponse.json({ history: [], raw: data })
  } catch {
    return NextResponse.json({ error: 'Unable to load edit history' }, { status: 500 })
  }
}
