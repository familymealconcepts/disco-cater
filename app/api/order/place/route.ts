import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'node:crypto'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'
import { sql } from '../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// disco_orders.order_status CHECK set (001_disco_orders.sql).
const ALLOWED_STATUS = new Set([
  'CART', 'RESERVED', 'DUE', 'COMPLETED', 'CANCELED', 'REFUND',
  'PARTIAL_REFUND', 'EXPIRED', 'VOID', 'UNPAID', 'PAID',
])

// The checkout DTO sends orderDate as DD.MM.YYYY (lib/pricing/checkout.ts toFmDate);
// disco_orders.order_date is a Postgres DATE, so normalize to YYYY-MM-DD. Pass
// through if already ISO; null if unrecognized (then we skip the insert).
function toIsoDate(d: unknown): string | null {
  if (typeof d !== 'string' || !d.trim()) return null
  const s = d.trim()
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  return null
}

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// Pull the canonical money off the FM place response. FM nests the priced totals
// under data.checkoutPublicResponseDto (or directly under data) — read both.
function extractMoney(fmInner: Record<string, unknown>): { subtotal: number; total: number; fee: number } {
  const d = ((fmInner.checkoutPublicResponseDto as Record<string, unknown>) ?? fmInner) as Record<string, unknown>
  const subtotal = num(d.subtotal ?? d.subTotal)
  const total = num(d.total ?? d.totalAmount ?? d.transactionsTotal)
  const fee = num(d.fee ?? d.fees)
  return { subtotal, total, fee }
}

// Fire-and-forget mirror of a placed FM order into Neon (disco_orders +
// disco_stripe_payments + disco_order_items). Wrapped so any failure is logged
// and swallowed — the checkout flow is never affected. The FM place response is
// the source of truth; Neon is a mirror. source_of_order is always "DISCO".
async function mirrorOrderToNeon(args: {
  restaurantRef: string
  orderRef: string
  placeBody: Record<string, unknown>
  fmData: unknown
}): Promise<void> {
  try {
    const { restaurantRef, orderRef, placeBody } = args
    const fm = (args.fmData ?? {}) as Record<string, unknown>
    const fmInner = (fm.data ?? {}) as Record<string, unknown>
    const customer = (placeBody.customer ?? {}) as Record<string, unknown>

    const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

    // CheckoutDrawer nests the priced DTO (orderDate/orderTime/orderType + items)
    // under checkoutDetails — read from there, not the top level of the place body.
    const checkoutDetails = (placeBody.checkoutDetails ?? {}) as Record<string, unknown>

    const reference = str(fmInner.orderReference) || str(fm.orderReference) || str(orderRef) || randomUUID()
    const orderNumber = str(fmInner.orderNumber) || str(fm.orderNumber) // BIGINT, NOT NULL UNIQUE
    const customerEmail = str(customer.email)
    const orderDate = toIsoDate(checkoutDetails.orderDate)
    const orderTime = str(checkoutDetails.orderTime)
    const orderType = checkoutDetails.orderType === 'DELIVERY' || placeBody.deliveryAddress ? 'DELIVERY' : 'PICKUP'
    const statusRaw = String(fmInner.orderStatus ?? fm.orderStatus ?? fmInner.status ?? '').toUpperCase()
    const orderStatus = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'
    const { subtotal, total, fee } = extractMoney(fmInner)
    // Tax-exempt id (Item 4) — sent on checkoutDetails; persisted so the
    // confirmation page, PDF, drawer, and emails can show it.
    const taxExemptId = str(checkoutDetails.taxExemptId)

    // FM creates the PaymentIntent during placement; its id is on the response.
    const paymentDetails = (fmInner.paymentDetails ?? fm.paymentDetails ?? {}) as Record<string, unknown>
    const stripeIntent = (paymentDetails.stripePaymentIntentDto ?? {}) as Record<string, unknown>
    const paymentIntentId = str(stripeIntent.paymentIntentId)

    // Items: the priced cart DTO (items[] with reference/name/count/price).
    const items = Array.isArray(checkoutDetails.items) ? (checkoutDetails.items as Record<string, unknown>[]) : []

    // Bail (no row) if any NOT-NULL-without-default column is missing — better
    // than a guaranteed constraint error. Logged so gaps are visible.
    if (!customerEmail || !restaurantRef || !orderDate || !orderTime || !orderNumber) {
      console.warn('[order/place] skip Neon mirror — missing required field:', {
        hasEmail: !!customerEmail, hasRestaurantRef: !!restaurantRef,
        hasDate: !!orderDate, hasTime: !!orderTime, hasOrderNumber: !!orderNumber,
      })
      return
    }

    // (a) disco_orders — upsert keyed by the FM order reference (== reference here),
    // DO UPDATE so retries refresh the money snapshot. RETURNING id for items.
    const orderRows = (await sql`
      INSERT INTO disco_orders (
        reference, order_number, order_status, order_type, source_of_order,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
        order_date, order_time, subtotal, total, fee, tax_exempt_id, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${reference}::uuid, ${orderNumber}::bigint, ${orderStatus}, ${orderType}, 'DISCO',
        ${restaurantRef}::uuid, ${customerEmail}, ${str(customer.firstName)}, ${str(customer.lastName)}, ${str(customer.phoneNumber)},
        ${orderDate}::date, ${orderTime}::time, ${subtotal}, ${total}, ${fee}, ${taxExemptId}, ${reference}::uuid, NOW(), NOW()
      )
      ON CONFLICT (reference) DO UPDATE SET
        subtotal = EXCLUDED.subtotal, total = EXCLUDED.total, fee = EXCLUDED.fee,
        order_status = EXCLUDED.order_status, fm_order_reference = EXCLUDED.fm_order_reference,
        tax_exempt_id = COALESCE(EXCLUDED.tax_exempt_id, disco_orders.tax_exempt_id), updated_at = NOW()
      RETURNING id
    `) as { id: number }[]
    const orderId = orderRows[0]?.id
    if (!orderId) return

    // (b) disco_stripe_payments — the PaymentIntent FM created for this order.
    if (paymentIntentId) {
      await sql`
        INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, total, created_at)
        VALUES (${reference}::uuid, ${restaurantRef}::uuid, ${paymentIntentId}, 'SUCCEEDED', ${total}, NOW())
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
      `
    }

    // (c) disco_order_items — replace (no natural unique key for ON CONFLICT, so
    // delete-then-insert keeps the mirror idempotent across retries).
    if (items.length) {
      await sql`DELETE FROM disco_order_items WHERE order_id = ${orderId}`
      for (const it of items) {
        const name = str(it.name) || str(it.reference) || 'Item'
        const qty = Math.max(1, Math.trunc(num(it.count ?? it.quantity) || 1))
        const unit = num(it.price)
        await sql`
          INSERT INTO disco_order_items (order_id, meal_package_reference, name, quantity, price_per_unit, total_price)
          VALUES (${orderId}, ${str(it.reference)}, ${name}, ${qty}, ${unit}, ${Math.round(unit * qty * 100) / 100})
        `
      }
    }
  } catch (e) {
    console.error('[order/place] Neon mirror failed:', e instanceof Error ? e.message : e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = await getFmCustomerJwt(req)
    if (!token) return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })

    const body = await req.json()
    const { restaurantRef, orderRef, ...placeBody } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    const res = await fetch(`${FM}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(placeBody),
    })
    const data = await res.json()

    // Mirror into Neon only after FM accepted the order. Fire-and-forget via
    // waitUntil — non-blocking and never affects the response below.
    if (res.ok) {
      waitUntil(mirrorOrderToNeon({ restaurantRef, orderRef, placeBody, fmData: data }))
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
