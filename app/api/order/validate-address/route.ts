import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { validateNativeDelivery } from '../../../../lib/order/native-delivery'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Whether a restaurant reference belongs to a Disco-native restaurant (no FM
// record). Native restaurants must never hit FM — they validate delivery in Neon.
async function isDiscoNative(ref: string): Promise<boolean> {
  if (!ref) return false
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_cache
    WHERE restaurant_reference = ${ref} AND is_disco_native = true LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length > 0
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const ref: string = body?.restaurantReference || body?.restaurantRef || ''

    // ── Disco-native path: geocode + distance + fee in Neon, zero FM. ──
    if (await isDiscoNative(ref)) {
      // menuReference was already being sent here (for FM's own activity-tracker
      // use on the FM path below) — now also used to resolve the RIGHT menu's
      // delivery method instead of guessing the restaurant's "primary" menu.
      const menuReference = typeof body?.menuReference === 'string' ? body.menuReference : undefined
      const result = await validateNativeDelivery(ref, body?.deliveryAddress || {}, Number(body?.subtotal) || 0, undefined, menuReference)
      return NextResponse.json(result)
    }

    // ── FM path (existing FM-backed restaurants) — unchanged. ──
    const res = await fetch(`${FM}/public-api/delivery/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to validate address' }, { status: 500 })
  }
}
