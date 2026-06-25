import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'
import { dispatchOrderConfirmations } from '../../../../lib/order-notifications'
import { sql } from '../../../../lib/db'
import { createDelivery, buildPayloadFromNeon } from '../../../../lib/expedite'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Native customer payments are charged on FM's Stripe, so Disco's webhook never
// sees the payment_intent.succeeded — confirmations must be triggered here once
// FM reports the charge succeeded. The Neon mirror (/api/order/place) writes the
// disco_orders row asynchronously, so poll briefly for it before dispatching.
// Idempotent: dispatchOrderConfirmations only sends once per order.
// Create the Expedite third-party delivery for a DELIVERY order after payment.
// Best-effort: a failure is logged and never propagates to the payment flow.
async function createExpediteDelivery(orderId: number, orderReference: string): Promise<void> {
  try {
    const rows = (await sql`
      SELECT order_type, expedite_delivery_id FROM disco_orders WHERE id = ${orderId} LIMIT 1
    `.catch(() => [])) as { order_type: string; expedite_delivery_id: string | null }[]
    const row = rows[0]
    if (!row || row.order_type !== 'DELIVERY' || row.expedite_delivery_id) return // not delivery, or already created

    const payload = await buildPayloadFromNeon(orderReference)
    if (!payload) { console.warn('[order/confirm-payment] expedite: could not build payload for', orderReference); return }

    const result = await createDelivery(payload)
    if (result.success) {
      await sql`
        UPDATE disco_orders
        SET expedite_delivery_id = ${payload.external_delivery_id},
            expedite_delivery_fee = ${result.delivery_fee ?? null},
            delivery_type = 'THIRD_PARTY_DELIVERY',
            updated_at = NOW()
        WHERE id = ${orderId}
      `.catch(e => console.error('[order/confirm-payment] expedite row update failed:', e instanceof Error ? e.message : e))
      console.log('[order/confirm-payment] expedite delivery created for', orderReference)
    } else {
      console.error('[order/confirm-payment] expedite createDelivery failed:', result.error)
    }
  } catch (e) {
    console.error('[order/confirm-payment] createExpediteDelivery error:', e instanceof Error ? e.message : e)
  }
}

async function dispatchAfterConfirm(orderReference: string): Promise<void> {
  if (!UUID_RE.test(orderReference)) return
  for (let attempt = 0; attempt < 6; attempt++) {
    const rows = (await sql`
      SELECT id FROM disco_orders
      WHERE fm_order_reference = ${orderReference}::uuid OR reference = ${orderReference}::uuid
      LIMIT 1
    `.catch(() => [])) as { id: number }[]
    if (rows[0]?.id) {
      // The card just charged. The place mirror writes FM's pre-payment status
      // (often RESERVED/UNPAID) — promote it to DUE so the order doesn't linger as
      // "Reserved" in the restaurant portal. Only nudge those two; never override a
      // COMPLETED/CANCELED/etc. set elsewhere.
      await sql`
        UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW()
        WHERE id = ${rows[0].id} AND order_status IN ('RESERVED', 'UNPAID')
      `.catch(e => console.error('[order/confirm-payment] status→DUE failed:', e instanceof Error ? e.message : e))
      // Expedite delivery — create for DELIVERY orders that don't already have one.
      // Best-effort: never blocks confirmation or notifications.
      await createExpediteDelivery(rows[0].id, orderReference)
      await dispatchOrderConfirmations(rows[0].id, 'CONFIRM_PAYMENT')
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.warn('[order/confirm-payment] order not mirrored in time — confirmations not dispatched:', orderReference)
}

export async function POST(req: NextRequest) {
  try {
    // Resolve the FM JWT from the Disco-native session (disco_customer_token),
    // with legacy disco_token fallback + refresh — the Stripe charge confirmation
    // fails silently otherwise (e.g. right after a native-auth signup).
    const token = await getFmCustomerJwt(req)
    if (!token) return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })

    const body = await req.json()
    const res = await fetch(`${FM}/api/userOrder/confirmPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()

    // DIAGNOSTIC: full FM confirmPayment response — shows the stripePaymentIntentDto
    // (paymentIntentStatus) so we can see whether the card was actually charged.
    const inner = (data?.data ?? data ?? {}) as Record<string, unknown>
    console.log('[order/confirm-payment] FM response', {
      httpStatus: res.status,
      stripePaymentIntentDto: inner?.stripePaymentIntentDto ?? null,
    })
    console.log('[order/confirm-payment] FM response FULL BODY:', JSON.stringify(data))

    // Charge confirmed → fire the order confirmations (customer + restaurant
    // email, SMS, Slack). FM reports success as stripePaymentIntentDto.
    // paymentIntentStatus === 'succeeded'. Fire-and-forget via waitUntil so it
    // never blocks the checkout response; idempotent so a later webhook (if any)
    // won't double-send.
    const payStatus = (inner?.stripePaymentIntentDto as Record<string, unknown> | undefined)?.paymentIntentStatus
    const charged = res.ok && !!payStatus && String(payStatus).toLowerCase() === 'succeeded'
    const orderReference = String(body?.orderReference || '')
    if (charged && orderReference) {
      waitUntil(dispatchAfterConfirm(orderReference))
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 })
  }
}
