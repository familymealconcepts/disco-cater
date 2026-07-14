import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { cancelDelivery } from '../../../../../../lib/expedite'
import { sendCustomerOrderCancellation } from '../../../../../../lib/email/notifications'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VOID_NOTE = 'Order voided by restaurant — food prepared, not fulfilled'

// PUT /api/restaurant/orders/{ref}/void
// Disco-native void — Neon only. Deliberately does NOT:
//   • touch Stripe (no refund is issued)
//   • send any Mailgun email (the customer is not notified)
//   • call the FM API (no FM sync)
// It marks the order VOIDED (food was prepared but not fulfilled) and logs a
// VOIDED event. The order stays visible in the orders list (History tab).
export async function PUT(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })

  // Ownership: the order must belong to a restaurant this caller may act on.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  try {
    await runDiscoOrderMigrations() // ensures VOIDED is an allowed order_status

    // Match on either the Disco reference or the FM reference: the orders list
    // surfaces fm_order_reference as the order id whenever it's present.
    const rows = (await sql`
      UPDATE disco_orders
      SET order_status = 'VOIDED', updated_at = NOW()
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      RETURNING reference, expedite_delivery_id, customer_email, customer_first_name,
                customer_last_name, restaurant_reference, restaurant_name
    `) as Array<{
      reference: string; expedite_delivery_id: string | null
      customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
      restaurant_reference: string | null; restaurant_name: string | null
    }>

    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const o = rows[0]
    const reference = o.reference

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${reference}::uuid, 'VOIDED', ${JSON.stringify({ note: VOID_NOTE })}::jsonb, 'DISCO_VOID')
    `

    // Cancel the Expedite delivery if one was dispatched (best-effort).
    if (o.expedite_delivery_id) {
      const result = await cancelDelivery(o.expedite_delivery_id)
      console.log('[restaurant/orders/void] expedite cancel:', result.success ? 'ok' : result.error)
    }

    // Notify the customer their order was canceled (best-effort — never block the void).
    if (o.customer_email) {
      try {
        const rc = (await sql`
          SELECT name, phone FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurant_reference} LIMIT 1
        `) as { name: string | null; phone: string | null }[]
        await sendCustomerOrderCancellation({
          to: o.customer_email,
          firstName: o.customer_first_name || undefined,
          lastName: o.customer_last_name || undefined,
          businessName: rc[0]?.name || o.restaurant_name || 'the restaurant',
          businessPhone: rc[0]?.phone || undefined,
        })
      } catch (e) {
        console.error('[restaurant/orders/void] cancellation email failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    return NextResponse.json({ ok: true, orderStatus: 'VOIDED' })
  } catch (err) {
    console.error('[restaurant/orders/void] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to void order' }, { status: 500 })
  }
}
