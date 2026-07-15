import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'
import { dispatchOrderConfirmations } from '../../../../lib/order-notifications'
import { sql } from '../../../../lib/db'
import { createDelivery, buildPayloadFromNeon } from '../../../../lib/expedite'
import { fmFetch } from '../../../../lib/fm-fetch'
import { alertOps } from '../../../../lib/ops-alert'

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

// Minimal placed-order snapshot the client sends on confirm, used to write the
// Neon row directly when the async place mirror hasn't landed in time.
interface PlacedOrderFallback {
  orderNumber?: number | string
  restaurantRef?: string
  sourceOfOrder?: string
  orderType?: string
  orderDate?: string
  orderTime?: string
  email?: string
  firstName?: string
  lastName?: string
  phone?: string
  companyName?: string
  total?: number
  deliveryAddress?: { addressLine1?: string; addressLine2?: string; city?: string; state?: string; zip?: string; latitude?: number; longitude?: number } | null
  items?: Array<{ reference?: string; name?: string; count?: number; price?: number }>
}

// Idempotently write the disco_orders row from the place-response data when the
// async mirror didn't land in time. Keyed on `reference` (same as the place
// mirror) so there's no duplicate. Returns the order id or null.
async function ensureRowFromPlaced(orderReference: string, p: PlacedOrderFallback): Promise<number | null> {
  if (!p?.orderNumber || !p.restaurantRef || !p.email || !p.orderDate || !p.orderTime) return null
  try {
    const orderType = String(p.orderType).toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
    const deliveryType = orderType === 'DELIVERY' ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'
    const da = p.deliveryAddress || {}
    const rows = (await sql`
      INSERT INTO disco_orders (
        reference, order_number, order_status, order_type, delivery_type, source_of_order,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone, company_name,
        delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
        delivery_lat, delivery_lng, order_date, order_time, total, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${orderReference}::uuid, ${p.orderNumber}::bigint, 'DUE', ${orderType}, ${deliveryType}, ${p.sourceOfOrder || 'DISCO'},
        ${p.restaurantRef}::uuid, ${p.email}, ${p.firstName || null}, ${p.lastName || null}, ${p.phone || null}, ${p.companyName || null},
        ${da.addressLine1 || null}, ${da.addressLine2 || null}, ${da.city || null}, ${da.state || null}, ${da.zip || null},
        ${da.latitude ?? null}, ${da.longitude ?? null}, ${p.orderDate}::date, ${p.orderTime}::time,
        ${p.total ?? null}, ${orderReference}::uuid, NOW(), NOW()
      )
      ON CONFLICT (reference) DO UPDATE SET order_status = 'DUE',
        company_name = COALESCE(EXCLUDED.company_name, disco_orders.company_name), updated_at = NOW()
      RETURNING id
    `.catch(e => { console.error('[order/confirm-payment] fallback insert failed:', e instanceof Error ? e.message : e); return [] })) as { id: number }[]
    const id = rows[0]?.id ?? null
    if (id && Array.isArray(p.items) && p.items.length) {
      await sql`DELETE FROM disco_order_items WHERE order_id = ${id}`.catch(() => {})
      for (const it of p.items) {
        const qty = Math.max(1, Math.trunc(Number(it.count) || 1))
        const unit = Number(it.price) || 0
        await sql`
          INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price)
          VALUES (${id}, ${it.reference || null}, ${it.name || 'Item'}, ${qty}, ${unit}, ${Math.round(unit * qty * 100) / 100})
        `.catch(() => {})
      }
    }
    return id
  } catch (e) {
    console.error('[order/confirm-payment] ensureRowFromPlaced failed:', e instanceof Error ? e.message : e)
    return null
  }
}

async function dispatchAfterConfirm(orderReference: string, placedOrder?: PlacedOrderFallback): Promise<void> {
  if (!UUID_RE.test(orderReference)) return

  // Poll up to 12s for the async place mirror to write the row.
  let orderId: number | null = null
  for (let attempt = 0; attempt < 12; attempt++) {
    const rows = (await sql`
      SELECT id FROM disco_orders
      WHERE fm_order_reference = ${orderReference}::uuid OR reference = ${orderReference}::uuid
      LIMIT 1
    `.catch(() => [])) as { id: number }[]
    if (rows[0]?.id) { orderId = rows[0].id; break }
    await new Promise((r) => setTimeout(r, 1000))
  }

  // Fallback: the mirror never landed — write the row from the place-response data
  // so confirmations + Expedite still fire rather than being skipped entirely.
  if (!orderId && placedOrder) {
    console.warn('[order/confirm-payment] mirror missed the poll window — using place-response fallback:', orderReference)
    orderId = await ensureRowFromPlaced(orderReference, placedOrder)
  }
  if (!orderId) {
    // Worst case: the customer paid on FM, the mirror never landed, and there's no
    // fallback data — so Disco has no order row, no confirmation, no Expedite. Make
    // it LOUD (the sync-fm-orders backstop should still pull the order later, and
    // its DISCO-order backfill will then fire the confirmation).
    await alertOps('order/confirm-payment: paid order not recorded on Disco — no confirmation dispatched (awaiting sync backfill)', {
      orderReference,
    })
    return
  }

  // The card just charged. The place mirror writes FM's pre-payment status
  // (often RESERVED/UNPAID) — promote it to DUE. Only nudge those two.
  await sql`
    UPDATE disco_orders SET order_status = 'DUE', updated_at = NOW()
    WHERE id = ${orderId} AND order_status IN ('RESERVED', 'UNPAID')
  `.catch(e => console.error('[order/confirm-payment] status→DUE failed:', e instanceof Error ? e.message : e))
  // Expedite delivery — best-effort; never blocks confirmations.
  await createExpediteDelivery(orderId, orderReference)
  await dispatchOrderConfirmations(orderId, 'CONFIRM_PAYMENT')
}

export async function POST(req: NextRequest) {
  try {
    // Resolve the FM JWT from the Disco-native session (disco_customer_token),
    // with legacy disco_token fallback + refresh — the Stripe charge confirmation
    // fails silently otherwise (e.g. right after a native-auth signup).
    const token = await getFmCustomerJwt(req)
    if (!token) return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })

    const body = await req.json()
    const res = await fmFetch(`${FM}/api/userOrder/confirmPayment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()

    // FM reports the charge result under stripePaymentIntentDto.paymentIntentStatus.
    const inner = (data?.data ?? data ?? {}) as Record<string, unknown>

    // Charge confirmed → fire the order confirmations (customer + restaurant
    // email, SMS, Slack). FM reports success as stripePaymentIntentDto.
    // paymentIntentStatus === 'succeeded'. Fire-and-forget via waitUntil so it
    // never blocks the checkout response; idempotent so a later webhook (if any)
    // won't double-send.
    const payStatus = (inner?.stripePaymentIntentDto as Record<string, unknown> | undefined)?.paymentIntentStatus
    const charged = res.ok && !!payStatus && String(payStatus).toLowerCase() === 'succeeded'
    const orderReference = String(body?.orderReference || '')
    if (charged && orderReference) {
      waitUntil(dispatchAfterConfirm(orderReference, body?.placedOrder as PlacedOrderFallback | undefined))
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to confirm payment' }, { status: 500 })
  }
}
