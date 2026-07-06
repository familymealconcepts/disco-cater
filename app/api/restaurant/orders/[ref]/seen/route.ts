import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: mark the order seen in Neon (was FM → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    try {
      await runDiscoOrderMigrations()
      await sql`UPDATE disco_orders SET seen_by_admin = true, updated_at = NOW() WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid`
      return NextResponse.json({ ok: true })
    } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/orders/${ref}/seenByAdmin`, { method: 'PUT', headers: authHeaders })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
  }
}
