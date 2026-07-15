import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getCallerScopeRefs } from '../../../../../lib/order/order-scope'
import { isDiscoNativeRestaurant } from '../../../../../lib/order/native-checkout'
import { placeNativeCheckout } from '../../../../../lib/order/native-place-checkout'
import { sanitizePhoneFields } from '../../../../../lib/utils/phone'
import { sql } from '../../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
}

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

// Fire-and-forget mirror of a placed direct-entry order into Neon disco_orders.
// Same pattern as app/api/order/place, but source_of_order is always
// "FAMILYMEAL" (direct entry = restaurant placing for its own customer → 1P, no
// lead-gen fee). Wrapped so any failure is logged and swallowed — the place
// flow is never affected. ON CONFLICT keeps retries idempotent.
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
    // CheckoutDrawer nests the priced DTO (orderDate/orderTime/orderType) under
    // checkoutDetails — read from there, not the top level of the place body.
    const checkoutDetails = (placeBody.checkoutDetails ?? {}) as Record<string, unknown>

    const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

    const reference = str(fmInner.orderReference) || str(fm.orderReference) || str(orderRef) || randomUUID()
    const orderNumber = str(fmInner.orderNumber) || str(fm.orderNumber) // BIGINT, NOT NULL UNIQUE
    const customerEmail = str(customer.email)
    const orderDate = toIsoDate(checkoutDetails.orderDate)
    const orderTime = str(checkoutDetails.orderTime)
    const orderType = checkoutDetails.orderType === 'DELIVERY' || placeBody.deliveryAddress ? 'DELIVERY' : 'PICKUP'
    const statusRaw = String(fmInner.orderStatus ?? fm.orderStatus ?? fmInner.status ?? '').toUpperCase()
    const orderStatus = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'
    const taxExemptId = str(checkoutDetails.taxExemptId)

    // Bail (no row) if any NOT-NULL-without-default column is missing — better
    // than a guaranteed constraint error. Logged so gaps are visible.
    if (!customerEmail || !restaurantRef || !orderDate || !orderTime || !orderNumber) {
      console.warn('[restaurant/orders/place] skip Neon mirror — missing required field:', {
        hasEmail: !!customerEmail, hasRestaurantRef: !!restaurantRef,
        hasDate: !!orderDate, hasTime: !!orderTime, hasOrderNumber: !!orderNumber,
      })
      return
    }

    await sql`
      INSERT INTO disco_orders (
        reference, order_number, order_status, order_type, source_of_order,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
        order_date, order_time, tax_exempt_id, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${reference}::uuid, ${orderNumber}::bigint, ${orderStatus}, ${orderType}, 'FAMILYMEAL',
        ${restaurantRef}::uuid, ${customerEmail}, ${str(customer.firstName)}, ${str(customer.lastName)}, ${str(customer.phoneNumber)},
        ${orderDate}::date, ${orderTime}::time, ${taxExemptId}, ${str(orderRef)}::uuid, NOW(), NOW()
      )
      ON CONFLICT (reference) DO NOTHING
    `
  } catch (e) {
    console.error('[restaurant/orders/place] Neon mirror failed:', e instanceof Error ? e.message : e)
  }
}

// Posts an "Order Updated" notification to the Disco Slack channel when an edit
// is committed. Distinct from the green new-order ping: an orange (#FF9900)
// attachment, the "update, …" line format, and a trailing (DE) marker. Looks the
// restaurant name + city/state up from the cache (best-effort). Never throws;
// skips when the webhook is unset.
async function sendOrderUpdatedSlack(o: {
  orderRef: string
  restaurantRef: string
  originalTotal: number
  newTotal: number
  sourceOfOrder: string
  serviceType: string // 'P' (pickup) | 'D' (delivery)
  oldDate?: string
  oldTime?: string
  newDate?: string
  newTime?: string
}): Promise<void> {
  const url = process.env.SLACK_NEW_ORDER_WEBHOOK_URL
  if (!url) return
  try {
    let restaurantName = ''
    let city = ''
    let state = ''
    try {
      const rows = (await sql`SELECT name, location FROM disco_restaurant_cache WHERE restaurant_reference = ${o.restaurantRef} LIMIT 1`) as Record<string, unknown>[]
      restaurantName = rows[0]?.name ? String(rows[0].name) : ''
      // cache.location is "City, State" (restaurant-cache.ts).
      const parts = (rows[0]?.location ? String(rows[0].location) : '').split(',').map(s => s.trim()).filter(Boolean)
      city = parts[0] || ''
      state = parts[1] || ''
    } catch { /* name/location are optional */ }

    const orig = Number.isFinite(o.originalTotal) ? o.originalTotal : 0
    const next = Number.isFinite(o.newTotal) ? o.newTotal : 0
    const delta = next - orig
    const deltaStr = `${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)}`
    const place = restaurantName || o.restaurantRef

    const oldDate = o.oldDate || ''
    const oldTime = o.oldTime || ''
    const newDate = o.newDate || ''
    const newTime = o.newTime || ''
    const dateChanged = !!(oldDate && newDate) && (oldDate !== newDate || oldTime !== newTime)
    const when = dateChanged
      ? `${oldDate} ${oldTime} → ${newDate} ${newTime}`
      : `${newDate} ${newTime}`.trim()

    // update, {restaurantName}, {city}, {state}, ({delta} from $orig to $new), {when} - ({P|D})(DE)
    const text = `update, ${place}, ${city}, ${state}, (${deltaStr} from $${orig.toFixed(2)} to $${next.toFixed(2)}), ${when} - (${o.serviceType})(DE)`

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [{ color: '#FF9900', text, fallback: text }] }),
    })
  } catch (err) {
    console.error('[restaurant/orders/place] Slack update notification failed:', err instanceof Error ? err.message : err)
  }
}

// Restaurant-portal "Create Order" (Direct Entry) place endpoint.
// Same FM endpoint as the customer place flow (POST /api/v2/restaurants/{ref}/
// orders/{orderRef}) — FM's own admin Create Order uses this exact endpoint
// with the restaurant admin's JWT (see familymeal-platform jwt.interceptor +
// meal-package.service checkoutOrderV2). The ONLY difference from
// app/api/order/place is auth: restaurant token (cookie) instead of the
// customer token, so portal staff can place on behalf of a customer.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  // editSlack is a Disco-only marker for the edit-commit flow — pull it out so
  // it's never forwarded to FM, and so its presence gates the "Order Updated"
  // Slack ping (the new-order direct-entry flow never sends it).
  const { restaurantRef, orderRef, editSlack, ...placeBody } = body as {
    restaurantRef?: string; orderRef?: string; editSlack?: unknown; [k: string]: unknown
  }
  if (!restaurantRef || !orderRef) {
    return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
  }

  // ── Disco-native Direct Entry: place in Neon/Stripe (zero FM) — RM4. The FM
  // proxy below has no native record and fails; the restaurant admin places on
  // behalf of a walk-in/phone customer, so the customer identity comes from the
  // entered form (not a diner session). Uses the SAME placeNativeCheckout helper
  // as the customer flow, and only for a restaurant the caller actually owns.
  if (await isDiscoNativeRestaurant(restaurantRef)) {
    const scope = await getCallerScopeRefs(ctx)
    if (!scope.has(restaurantRef.toLowerCase())) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    const cd = (placeBody.checkoutDetails ?? {}) as Record<string, unknown>
    // Invoice (unpaid + emailed payment link) isn't built for native yet — be
    // explicit rather than silently failing at FM.
    if (String(cd.paymentMethod ?? '').toUpperCase() === 'INVOICE') {
      return NextResponse.json({ error: 'Invoice orders aren’t available for Disco-native restaurants yet — use the Payment method.' }, { status: 400 })
    }
    const stripe = stripeClient()
    if (!stripe) return NextResponse.json({ error: 'Payment is temporarily unavailable.' }, { status: 503 })
    const cust = (placeBody.customer ?? {}) as Record<string, unknown>
    const email = String(cust.email ?? '').trim()
    if (!email) return NextResponse.json({ error: 'A customer email is required.' }, { status: 400 })

    const outcome = await placeNativeCheckout({
      restaurantReference: restaurantRef,
      customerEmail: email,
      customerFirstName: (cust.firstName as string) ?? null,
      customerLastName: (cust.lastName as string) ?? null,
      customerPhone: (cust.phoneNumber as string) ?? null,
      checkoutDetails: cd,
      deliveryAddress: placeBody.deliveryAddress,
      note: (placeBody.note as string) ?? null,
      companyName: (placeBody.companyName as string) ?? null,
      headcount: (placeBody.headcount ?? cd.headcount ?? null) as number | null,
      stripe,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    const result = outcome.result
    return NextResponse.json({
      native: true,
      orderReference: result.orderReference,
      orderNumber: result.orderNumber,
      paymentIntentId: result.paymentIntentId,
      clientSecret: result.clientSecret,
      withheld: result.withheld,
      breakdown: result.breakdown,
    })
  }

  // ── FM-backed Direct Entry (existing) ──
  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    // FM rejects formatted phone numbers — digits only. Sanitize every phone
    // field in the place payload before FM (mutates placeBody → Neon mirror too).
    sanitizePhoneFields(placeBody)

    const res = await fetch(`${FM}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(placeBody),
    })
    const data = await res.json().catch(() => ({}))

    // Mirror into Neon only after FM accepted the order. Fire-and-forget via
    // waitUntil — non-blocking and never affects the response below.
    if (res.ok) {
      waitUntil(mirrorOrderToNeon({ restaurantRef, orderRef, placeBody, fmData: data }))
      // Edit commits carry editSlack → fire the "Order Updated" Slack ping.
      if (editSlack) {
        const es = editSlack as Record<string, unknown>
        // Service type for the (P|D) marker — same derivation as the Neon mirror.
        const checkoutDetails = (placeBody.checkoutDetails ?? {}) as Record<string, unknown>
        const isDelivery = checkoutDetails.orderType === 'DELIVERY' || !!placeBody.deliveryAddress
        const optStr = (v: unknown) => (v == null || v === '' ? undefined : String(v))
        waitUntil(sendOrderUpdatedSlack({
          orderRef: String(es.orderRef ?? orderRef),
          restaurantRef,
          originalTotal: Number(es.originalTotal) || 0,
          newTotal: Number(es.newTotal) || 0,
          sourceOfOrder: String(es.sourceoforder ?? ''),
          serviceType: isDelivery ? 'D' : 'P',
          oldDate: optStr(es.oldDate),
          oldTime: optStr(es.oldTime),
          newDate: optStr(es.newDate),
          newTime: optStr(es.newTime),
        }))
      }
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
