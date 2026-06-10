import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'node:crypto'
import { getToken } from '../../../../lib/auth'
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

// Fire-and-forget mirror of a placed FM order into Neon disco_orders, using the
// customer + order data available in the place request and FM response. Wrapped
// so any failure is logged and swallowed — the checkout flow is never affected.
// source_of_order is always "DISCO" (orders through discocater.com); ON CONFLICT
// keeps retries idempotent.
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

    const reference = str(fmInner.orderReference) || str(fm.orderReference) || str(orderRef) || randomUUID()
    const orderNumber = str(fmInner.orderNumber) || str(fm.orderNumber) // BIGINT, NOT NULL UNIQUE
    const customerEmail = str(customer.email)
    const orderDate = toIsoDate(placeBody.orderDate)
    const orderTime = str(placeBody.orderTime)
    const orderType = placeBody.orderType === 'DELIVERY' || placeBody.deliveryAddress ? 'DELIVERY' : 'PICKUP'
    const statusRaw = String(fmInner.orderStatus ?? fm.orderStatus ?? fmInner.status ?? '').toUpperCase()
    const orderStatus = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'

    // Bail (no row) if any NOT-NULL-without-default column is missing — better
    // than a guaranteed constraint error. Logged so gaps are visible.
    if (!customerEmail || !restaurantRef || !orderDate || !orderTime || !orderNumber) {
      console.warn('[order/place] skip Neon mirror — missing required field:', {
        hasEmail: !!customerEmail, hasRestaurantRef: !!restaurantRef,
        hasDate: !!orderDate, hasTime: !!orderTime, hasOrderNumber: !!orderNumber,
      })
      return
    }

    await sql`
      INSERT INTO disco_orders (
        reference, order_number, order_status, order_type, source_of_order,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
        order_date, order_time, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${reference}::uuid, ${orderNumber}::bigint, ${orderStatus}, ${orderType}, 'DISCO',
        ${restaurantRef}::uuid, ${customerEmail}, ${str(customer.firstName)}, ${str(customer.lastName)}, ${str(customer.phoneNumber)},
        ${orderDate}::date, ${orderTime}::time, ${str(orderRef)}::uuid, NOW(), NOW()
      )
      ON CONFLICT (reference) DO NOTHING
    `
  } catch (e) {
    console.error('[order/place] Neon mirror failed:', e instanceof Error ? e.message : e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

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
