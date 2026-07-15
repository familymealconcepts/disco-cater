import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql } from '../../../../../../lib/db'
import { refundNativeOrder } from '../../../../../../lib/order/native-refund'
import { stripeClient } from '../../../../../../lib/order/native-payment'
import { sendCustomerRefundNotification } from '../../../../../../lib/email/notifications'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  let nativeRow: { discoReference: string; total: number; refund: number } | null = null
  if (UUID_RE.test(ref)) {
    try {
      const rows = (await sql`
        SELECT o.reference::text AS disco_reference,
               COALESCE(NULLIF(o.total, 0),
                 (SELECT MAX(sp.total) FROM disco_stripe_payments sp WHERE sp.order_reference = o.reference AND sp.total > 0)
               ) AS total,
               COALESCE(o.refund, 0) AS refund
        FROM disco_orders o
        WHERE o.reference = ${ref}::uuid AND o.fm_order_reference IS NULL
        LIMIT 1
      `) as Array<{ disco_reference: string; total: string | null; refund: string | null }>
      if (rows[0]) nativeRow = { discoReference: rows[0].disco_reference, total: Number(rows[0].total) || 0, refund: Number(rows[0].refund) || 0 }
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

  // Stripe refund succeeded — mark the order refunded (source of truth) + notify.
  const totalRefund = Math.round((nativeRow.refund + amount) * 100) / 100
  try {
    const rows = (await sql`
      UPDATE disco_orders
      SET order_status = 'REFUNDED', refund = ${totalRefund}, updated_at = NOW()
      WHERE reference = ${nativeRow.discoReference}::uuid
      RETURNING reference, order_number, customer_email, customer_first_name,
                customer_last_name, restaurant_reference, restaurant_name
    `) as Array<{
      reference: string; order_number: string | number | null
      customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
      restaurant_reference: string | null; restaurant_name: string | null
    }>
    const o = rows[0]
    if (o) {
      await sql`
        INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
        VALUES (${o.reference}::uuid, 'REFUNDED', ${JSON.stringify({ amount, totalRefund, stripeRefundId })}::jsonb, 'ADMIN_REFUND')
      `.catch(e => console.error('[admin/orders/refund] event insert:', e instanceof Error ? e.message : e))

      if (o.customer_email) {
        try {
          const rc = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurant_reference} LIMIT 1`) as { name: string | null }[]
          await sendCustomerRefundNotification({
            to: o.customer_email,
            firstName: o.customer_first_name || '',
            lastName: o.customer_last_name || undefined,
            orderNumber: o.order_number ?? o.reference,
            refundAmount: amount,
            businessName: rc[0]?.name || o.restaurant_name || 'the restaurant',
          })
        } catch (e) {
          console.error('[admin/orders/refund] refund email failed (non-fatal):', e instanceof Error ? e.message : e)
        }
      }
    }
    return NextResponse.json({ ok: true, native: true, orderStatus: 'REFUNDED', refund: totalRefund, stripeRefundId })
  } catch (err) {
    // The refund already moved in Stripe — never report it as a failure. Surface the
    // record-update problem for manual reconciliation instead.
    console.error('[admin/orders/refund] Stripe refunded but Neon update failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: true, native: true, stripeRefundId, warning: 'Refund issued in Stripe, but the order record failed to update.' })
  }
}
