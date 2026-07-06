import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getFmServiceAuthHeader } from '../../../../../../lib/fm-service-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM_BASE = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Returns the edit history for an order. FM doesn't (yet) expose a dedicated
// edit-history endpoint, so we pull the full order details and surface any
// edit-history-shaped array we can find. The exact wire shape is unconfirmed,
// so when we can't recognize it we return the raw payload for inspection.
// Auth: the SUPER_ADMIN service JWT (raw, no "Bearer" prefix) — Disco-native
// users have no FM token and a restaurant user's own token isn't authorized.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Gate: require an authenticated restaurant user (Disco-native OR legacy FM).
  const ctx = await getRestaurantAuthContext()
  if (!ctx) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  // Disco-native: read the edit history from disco_order_edits (was read from FM).
  if (ctx.authType === 'disco') {
    try {
      await runDiscoOrderMigrations()
      const history = (await sql`
        SELECT edit_number AS "editNumber",
               editor_email AS "editedBy",
               to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt",
               original_total::float8 AS "previousTotal",
               new_total::float8 AS "newTotal",
               delta::float8 AS "delta",
               to_char(original_date, 'YYYY-MM-DD') AS "originalDate",
               to_char(new_date, 'YYYY-MM-DD') AS "newDate",
               payment_action AS "paymentAction",
               payment_status AS "paymentStatus"
        FROM disco_order_edits
        WHERE fm_order_reference = ${ref}::uuid
        ORDER BY edit_number ASC
      `) as Record<string, unknown>[]
      return NextResponse.json({ history })
    } catch (err) {
      console.error('[orders/edit-history] disco read failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Unable to load edit history' }, { status: 500 })
    }
  }

  let auth: Record<string, string>
  try {
    auth = await getFmServiceAuthHeader()
  } catch (err) {
    console.error('[orders/edit-history] service auth failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Service auth unavailable' }, { status: 500 })
  }

  try {
    const res = await fetch(`${FM_BASE}/public-api/v2/orders/${ref}/details`, {
      headers: { ...auth, Accept: 'application/json' },
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
