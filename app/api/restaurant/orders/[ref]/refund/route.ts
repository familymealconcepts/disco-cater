import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// PUT /api/restaurant/orders/{ref}/refund  { amount }
// Records the refund in Disco's Neon (source of truth): order_status → REFUNDED
// and disco_orders.refund = amount, so the orders list shows "Refunded" and the
// details panel shows the badge + refund amount. FM is notified best-effort (it
// owns the actual Stripe refund for FM-charged orders); a FM failure never blocks
// the Neon write.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })

  let amount = 0
  try {
    const body = await req.json()
    amount = Math.max(0, Number(body?.amount) || 0)
  } catch { /* amount stays 0 */ }
  if (!(amount > 0)) return NextResponse.json({ error: 'Refund amount required' }, { status: 400 })

  // Validate against the order total minus anything already refunded. Effective
  // total falls back to the Stripe payment total (matching the orders list) so a
  // null/0 disco_orders.total doesn't block a legitimate refund.
  let maxRefundable = 0
  let alreadyRefunded = 0
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
             ) AS total,
             COALESCE(o.refund, 0) AS refund
      FROM disco_orders o
      WHERE o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as Array<{ total: string | null; refund: string | null }>
    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const total = Number(rows[0].total) || 0
    alreadyRefunded = Number(rows[0].refund) || 0
    maxRefundable = Math.max(0, total - alreadyRefunded)
  } catch (e) {
    console.error('[restaurant/orders/refund] max lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to process refund' }, { status: 500 })
  }
  if (amount > maxRefundable + 0.001) {
    return NextResponse.json({ error: `Refund amount cannot exceed $${maxRefundable.toFixed(2)}` }, { status: 400 })
  }

  // FM notification (best-effort) — issues the Stripe refund for FM-charged orders.
  try {
    const authHeaders = await getRestaurantAuthHeader()
    const res = await fetch(`${FM}/api/orders/${ref}/refund`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    })
    if (!res.ok) console.error('[restaurant/orders/refund] FM refund failed (non-fatal):', res.status)
  } catch (e) {
    console.error('[restaurant/orders/refund] FM refund threw (non-fatal):', e instanceof Error ? e.message : e)
  }

  // Neon is the source of truth — mark REFUNDED and store the cumulative refund.
  const totalRefund = Math.round((alreadyRefunded + amount) * 100) / 100
  try {
    const rows = (await sql`
      UPDATE disco_orders
      SET order_status = 'REFUNDED', refund = ${totalRefund}, updated_at = NOW()
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      RETURNING reference
    `) as Array<{ reference: string }>

    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const reference = rows[0].reference

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${reference}::uuid, 'REFUNDED', ${JSON.stringify({ amount, totalRefund })}::jsonb, 'DISCO_REFUND')
    `.catch(e => console.error('[restaurant/orders/refund] event insert:', e))

    return NextResponse.json({ ok: true, orderStatus: 'REFUNDED', refund: totalRefund })
  } catch (err) {
    console.error('[restaurant/orders/refund] Neon update failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to process refund' }, { status: 500 })
  }
}
