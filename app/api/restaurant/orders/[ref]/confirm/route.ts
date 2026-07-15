import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native session: native orders live in Neon, not FM, so the FM proxy
  // below would 401 (no FM token) — RH2. A native order is confirmed at payment
  // (RESERVED→DUE via the Stripe webhook); there's no separate restaurant-
  // acceptance step, so "confirm" is an idempotent acknowledge, scoped to the
  // caller's own order.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const scope = await assertOrderInScope(ref, ctx)
    if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT order_status FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid LIMIT 1
    `) as { order_status: string }[]
    return NextResponse.json({ ok: true, orderStatus: rows[0]?.order_status ?? null })
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const res = await fetch(`${FM}/api/restaurant/orders/${ref}/accept`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to confirm order', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/orders/[ref]/confirm error:', err)
    return NextResponse.json({ error: 'Unable to confirm order' }, { status: 500 })
  }
}
