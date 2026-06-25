import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'
import { dispatchOrderConfirmations } from '../../../../lib/order-notifications'
import { sql } from '../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Native customer payments are charged on FM's Stripe, so Disco's webhook never
// sees the payment_intent.succeeded — confirmations must be triggered here once
// FM reports the charge succeeded. The Neon mirror (/api/order/place) writes the
// disco_orders row asynchronously, so poll briefly for it before dispatching.
// Idempotent: dispatchOrderConfirmations only sends once per order.
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
