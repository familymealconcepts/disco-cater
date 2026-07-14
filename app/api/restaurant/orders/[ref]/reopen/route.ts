import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Ownership: the order must belong to a restaurant this caller may act on.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  // Disco-native: reopen a completed order (COMPLETED → DUE) in Neon.
  if (ctx.authType === 'disco') {
    try {
      await runDiscoOrderMigrations()
      const rows = (await sql`
        UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW()
        WHERE (reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid) AND order_status = 'COMPLETED'
        RETURNING id
      `) as { id: number }[]
      if (!rows.length) return NextResponse.json({ error: 'Order not found or not completed' }, { status: 404 })
      return NextResponse.json({ ok: true })
    } catch { return NextResponse.json({ error: 'Unable to reopen order' }, { status: 500 }) }
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/orders/${ref}/reopen`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to reopen order' }, { status: 500 })
  }
}
