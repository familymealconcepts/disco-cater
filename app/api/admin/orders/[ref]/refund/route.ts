import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { refundNativeOrder } from '../../../../../../lib/order/native-refund'
import { stripeClient } from '../../../../../../lib/order/native-payment'
import { sendOrderRefundEmail } from '../../../../../../lib/order/refund-email'
import { cancelDelivery } from '../../../../../../lib/expedite'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Statuses meaning the order was already dead before this refund — see the
// customer email's orderProceeding argument.
const CANCELLED_BEFORE_REFUND = new Set(['CANCELED', 'CANCELLED', 'VOID', 'VOIDED', 'REJECTED'])

// PUT /api/admin/orders/{ref}/refund  { amount }
// Disco-native orders (in disco_orders with no FM reference) are refunded through
// Disco's OWN Stripe via refundNativeOrder — a REAL refund that MUST succeed before
// the order is marked refunded (no status-only "looks refunded"). FM orders keep
// the existing FM proxy, unchanged.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  let amount = 0
  try { const body = await req.json(); amount = Math.max(0, Number(body?.amount) || 0) } catch { /* amount stays 0 */ }
  if (!(amount > 0)) return NextResponse.json({ error: 'Refund amount required' }, { status: 400 })

  // Native order? (disco_orders row with no fm_order_reference)
  let nativeRow: { discoReference: string; total: number; refund: number; priorStatus: string } | null = null
  if (UUID_RE.test(ref)) {
    try {
      const rows = (await sql`
        SELECT o.reference::text AS disco_reference, o.order_status AS prior_status,
               COALESCE(NULLIF(o.total, 0),
                 (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
               ) AS total,
               COALESCE(o.refund, 0) AS refund
        FROM disco_orders o
        WHERE o.reference = ${ref}::uuid AND o.fm_order_reference IS NULL
        LIMIT 1
      `) as Array<{ disco_reference: string; prior_status: string | null; total: string | null; refund: string | null }>
      // prior_status is captured BEFORE the UPDATE below overwrites order_status —
      // it is the only way to know whether a partially-refunded order was already
      // cancelled. See the customer email's orderProceeding note.
      if (rows[0]) nativeRow = {
        discoReference: rows[0].disco_reference,
        total: Number(rows[0].total) || 0,
        refund: Number(rows[0].refund) || 0,
        priorStatus: String(rows[0].prior_status || '').toUpperCase(),
      }
    } catch (e) {
      console.error('[admin/orders/refund] native lookup failed:', e instanceof Error ? e.message : e)
    }
  }

  // ── FM order: unchanged proxy ──
  if (!nativeRow) {
    try {
      const res = await fetch(`${FM}/api/admin/userOrders/${ref}/refund`, {
        method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      })
      if (!res.ok) return NextResponse.json({ error: 'Failed to refund' }, { status: res.status })

      // Fully refunded FM-backed order → stand down any booked courier. The
      // Stripe webhook's charge.refunded handler also catches this, but doing
      // it here too avoids waiting on the webhook round-trip. See the
      // confirm-payment fix + Winfield Street Coffee incident.
      const orderTotalRows = (await sql`
        SELECT COALESCE(NULLIF(total, 0), (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = disco_orders.reference AND sp.total > 0)) AS total,
               expedite_delivery_id
        FROM disco_orders WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid LIMIT 1
      `.catch(() => [])) as { total: string | null; expedite_delivery_id: string | null }[]
      const row = orderTotalRows[0]
      if (row?.expedite_delivery_id && row.expedite_delivery_id !== 'PENDING' && amount >= (Number(row.total) || 0) - 0.001) {
        const result = await cancelDelivery(row.expedite_delivery_id)
        console.log('[admin/orders/refund] FM-order expedite cancel:', result.success ? 'ok' : result.error)
      }
      return NextResponse.json({ ok: true })
    } catch {
      return NextResponse.json({ error: 'Unable to refund' }, { status: 500 })
    }
  }

  // ── Native refund: REAL Stripe refund, then Neon record. ──
  const maxRefundable = Math.max(0, nativeRow.total - nativeRow.refund)
  if (amount > maxRefundable + 0.001) {
    return NextResponse.json({ error: `Refund amount cannot exceed $${maxRefundable.toFixed(2)}` }, { status: 400 })
  }

  const stripe = stripeClient(process.env.STRIPE_SECRET_KEY)
  if (!stripe) return NextResponse.json({ error: 'Refunds are temporarily unavailable.' }, { status: 503 })

  let stripeRefundId: string
  try {
    const r = await refundNativeOrder(stripe, nativeRow.discoReference, amount)
    stripeRefundId = r.refundId
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[admin/orders/refund] native Stripe refund failed:', msg)
    return NextResponse.json({ error: `The refund could not be processed: ${msg}` }, { status: 502 })
  }

  // Stripe refund succeeded — record the cumulative refund + mark the status. A
  // refund that doesn't cover the whole order is PARTIAL_REFUND (distinguishable
  // from a full REFUND). 'REFUND', not 'REFUNDED' — matches FM's real
  // OrderStatus enum spelling and the majority of real rows; this writer used
  // to produce the minority spelling.
  const totalRefund = Math.round((nativeRow.refund + amount) * 100) / 100
  const newStatus = nativeRow.total > 0 && totalRefund < nativeRow.total - 0.001 ? 'PARTIAL_REFUND' : 'REFUND'
  try {
    const rows = (await sql`
      UPDATE disco_orders
      SET order_status = ${newStatus}, refund = ${totalRefund}, updated_at = NOW()
      WHERE reference = ${nativeRow.discoReference}::uuid
      RETURNING reference, order_number, customer_email, customer_first_name,
                customer_last_name, restaurant_reference, restaurant_name, expedite_delivery_id
    `) as Array<{
      reference: string; order_number: string | number | null
      customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
      restaurant_reference: string | null; restaurant_name: string | null; expedite_delivery_id: string | null
    }>
    const o = rows[0]
    if (o) {
      await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${o.reference}::uuid, 'REFUNDED', ${JSON.stringify({ amount, totalRefund, stripeRefundId, status: newStatus })}::jsonb, 'ADMIN_REFUND')
      `.catch(e => console.error('[admin/orders/refund] event insert:', e instanceof Error ? e.message : e))

      // Fully refunded (not a partial/goodwill adjustment) → stand down any
      // booked courier.
      if (newStatus === 'REFUND' && o.expedite_delivery_id && o.expedite_delivery_id !== 'PENDING') {
        const result = await cancelDelivery(o.expedite_delivery_id)
        console.log('[admin/orders/refund] expedite cancel:', result.success ? 'ok' : result.error)
      }

      // DISCO-source only, via the shared helper — see lib/order/refund-email.ts.
      await sendOrderRefundEmail({
        orderReference: o.reference,
        amount,
        totalRefunded: totalRefund,
        orderTotal: nativeRow.total,
        isPartial: newStatus === 'PARTIAL_REFUND',
        orderProceeding: newStatus !== 'PARTIAL_REFUND'
          ? undefined
          : !CANCELLED_BEFORE_REFUND.has(nativeRow.priorStatus),
      })
    }
    return NextResponse.json({ ok: true, native: true, orderStatus: newStatus, refund: totalRefund, stripeRefundId })
  } catch (err) {
    // The refund already moved in Stripe — never report it as a failure. Surface the
    // record-update problem for manual reconciliation instead.
    console.error('[admin/orders/refund] Stripe refunded but Neon update failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: true, native: true, stripeRefundId, warning: 'Refund issued in Stripe, but the order record failed to update.' })
  }
}
