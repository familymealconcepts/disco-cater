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
  // below would 401 (no FM token) — RH3. Reject only makes sense before payment
  // for a native order; a PAID native order must be undone via the Refund/Void
  // action (which actually refunds the customer) — reject must never leave a paid
  // order canceled-but-charged. Scoped to the caller's own order.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const scope = await assertOrderInScope(ref, ctx)
    if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT id, order_status FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid LIMIT 1
    `) as { id: number; order_status: string }[]
    const o = rows[0]
    if (!o) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    if (['RESERVED', 'UNPAID', 'CART'].includes(String(o.order_status))) {
      await sql`UPDATE disco_orders SET order_status = 'CANCELED', updated_at = NOW() WHERE id = ${o.id}`
      return NextResponse.json({ ok: true, orderStatus: 'CANCELED' })
    }
    return NextResponse.json({ error: 'This order is already paid — cancel it from the Refund or Void action so the customer is refunded.' }, { status: 409 })
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/restaurant/orders/${ref}/reject`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 401) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to reject order', raw: err }, { status: res.status })
    }
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch (err) {
    console.error('restaurant/orders/[ref]/reject error:', err)
    return NextResponse.json({ error: 'Unable to reject order' }, { status: 500 })
  }
}
