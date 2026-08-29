import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { assertOrderInScope } from '../../../../../../lib/order/order-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { sendCustomerRefundNotification } from '../../../../../../lib/email/notifications'
import { refundNativeOrder } from '../../../../../../lib/order/native-refund'
import { stripeClient } from '../../../../../../lib/order/native-payment'
import { cancelDelivery } from '../../../../../../lib/expedite'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// PUT /api/restaurant/orders/{ref}/refund  { amount }
// Records the refund in Disco's Neon (source of truth): order_status → 'REFUND'
// (or 'PARTIAL_REFUND' when it doesn't cover the whole order) and
// disco_orders.refund = amount, so the orders list shows "Refunded" and the details
// panel shows the badge + refund amount. FM is notified best-effort (it owns the
// actual Stripe refund for FM-charged orders); a FM failure never blocks the Neon
// write.
//
// 'REFUND', not 'REFUNDED' — this said REFUNDED while the code below has always
// written REFUND. That is the exact spelling distinction the write-site comment
// calls out (FM's real OrderStatus enum spelling, and the majority of stored rows),
// so a stale comment here pointed the next reader at the wrong value.
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

  // Ownership: a restaurant may only refund its OWN order. Enforced before any
  // Stripe refund / reverse_transfer so funds can't be clawed from another tenant.
  const scope = await assertOrderInScope(ref, ctx)
  if (!scope.ok) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  // Validate against the order total minus anything already refunded. Effective
  // total falls back to the Stripe payment total (matching the orders list) so a
  // null/0 disco_orders.total doesn't block a legitimate refund.
  let maxRefundable = 0
  let alreadyRefunded = 0
  let orderTotal = 0
  let discoReference = ''
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT o.reference AS disco_reference,
             COALESCE(NULLIF(o.total, 0),
               (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
             ) AS total,
             COALESCE(o.refund, 0) AS refund
      FROM disco_orders o
      WHERE o.reference = ${ref}::uuid OR o.fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as Array<{ disco_reference: string; total: string | null; refund: string | null }>
    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    discoReference = rows[0].disco_reference
    orderTotal = Number(rows[0].total) || 0
    alreadyRefunded = Number(rows[0].refund) || 0
    maxRefundable = Math.max(0, orderTotal - alreadyRefunded)
  } catch (e) {
    console.error('[restaurant/orders/refund] max lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to process refund' }, { status: 500 })
  }
  if (amount > maxRefundable + 0.001) {
    return NextResponse.json({ error: `Refund amount cannot exceed $${maxRefundable.toFixed(2)}` }, { status: 400 })
  }

  // Issue the ACTUAL Stripe refund. For a Disco-native order this goes through
  // Disco's own Stripe and MUST succeed before we mark the order refunded — no more
  // flipping the status while the money silently fails to move. FM-charged orders
  // are still refunded by FM (best-effort; FM owns their Stripe).
  let stripeRefundId: string | null = null
  if (ctx.authType === 'disco') {
    const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
    if (!stripe) return NextResponse.json({ error: 'Refunds are temporarily unavailable.' }, { status: 503 })
    try {
      const r = await refundNativeOrder(stripe, discoReference, amount)
      stripeRefundId = r.refundId
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[restaurant/orders/refund] native Stripe refund failed:', msg)
      return NextResponse.json({ error: `The refund could not be processed: ${msg}` }, { status: 502 })
    }
  } else {
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
  }

  // Neon is the source of truth — store the cumulative refund and mark the status.
  // A refund that doesn't cover the whole order is PARTIAL_REFUND, so it stays
  // distinguishable from a full REFUND in the list + the badge. 'REFUND', not
  // 'REFUNDED' — matches FM's real OrderStatus enum spelling and the majority
  // of real rows; this writer used to produce the minority spelling.
  const totalRefund = Math.round((alreadyRefunded + amount) * 100) / 100
  const newStatus = orderTotal > 0 && totalRefund < orderTotal - 0.001 ? 'PARTIAL_REFUND' : 'REFUND'
  try {
    const rows = (await sql`
      UPDATE disco_orders
      SET order_status = ${newStatus}, refund = ${totalRefund}, updated_at = NOW()
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      RETURNING reference, order_number, customer_email, customer_first_name,
                customer_last_name, restaurant_reference, restaurant_name, expedite_delivery_id
    `) as Array<{
      reference: string; order_number: string | number | null
      customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
      restaurant_reference: string | null; restaurant_name: string | null; expedite_delivery_id: string | null
    }>

    if (!rows.length) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    const o = rows[0]
    const reference = o.reference

    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (${reference}::uuid, 'REFUNDED', ${JSON.stringify({ amount, totalRefund, stripeRefundId, status: newStatus })}::jsonb, 'DISCO_REFUND')
    `.catch(e => console.error('[restaurant/orders/refund] event insert:', e))

    // Fully refunded (not a partial/goodwill adjustment) → stand down any booked
    // courier. See the confirm-payment fix + Winfield Street Coffee incident.
    if (newStatus === 'REFUND' && o.expedite_delivery_id && o.expedite_delivery_id !== 'PENDING') {
      const result = await cancelDelivery(o.expedite_delivery_id)
      console.log('[restaurant/orders/refund] expedite cancel:', result.success ? 'ok' : result.error)
    }

    // Notify the customer of the refund (best-effort — never block the refund).
    if (o.customer_email) {
      try {
        const rc = (await sql`
          SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurant_reference} LIMIT 1
        `) as { name: string | null }[]
        await sendCustomerRefundNotification({
          to: o.customer_email,
          firstName: o.customer_first_name || '',
          lastName: o.customer_last_name || undefined,
          orderNumber: o.order_number ?? reference,
          refundAmount: amount,
          businessName: rc[0]?.name || o.restaurant_name || 'the restaurant',
        })
      } catch (e) {
        console.error('[restaurant/orders/refund] refund email failed (non-fatal):', e instanceof Error ? e.message : e)
      }
    }

    return NextResponse.json({ ok: true, orderStatus: newStatus, refund: totalRefund })
  } catch (err) {
    console.error('[restaurant/orders/refund] Neon update failed:', err instanceof Error ? err.message : err)
    // NEVER REPORT A COMPLETED STRIPE REFUND AS A FAILURE. This returned a bare 500
    // "Unable to process refund" even when Stripe had already sent the money back —
    // so staff saw a failure, and the obvious next action is to retry, which is a
    // SECOND refund. Same principle the admin refund route already states.
    //
    // Conditional on stripeRefundId, deliberately, because this route serves BOTH
    // paths and the admin route's block only ever serves the native one:
    //   • native (authType 'disco') — stripeRefundId is set, so the refund is a
    //     confirmed fact and only the bookkeeping failed. Report success + warning.
    //   • FM-backed — FM owns the Stripe refund and this route only pokes it
    //     best-effort, logging failures rather than surfacing them. We do NOT know
    //     the money moved, so claiming success would be the opposite lie. Keep the
    //     500.
    if (stripeRefundId) {
      return NextResponse.json({
        ok: true,
        orderStatus: newStatus,
        refund: totalRefund,
        stripeRefundId,
        warning: 'Refund issued in Stripe, but the order record failed to update. Do NOT refund again — the customer has already been refunded. Please flag this order for manual reconciliation.',
      })
    }
    return NextResponse.json({ error: 'Unable to process refund' }, { status: 500 })
  }
}
