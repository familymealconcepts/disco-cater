import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getCallerScopeRefs } from '../../../../../lib/order/order-scope'
import { isDiscoNativeRestaurant } from '../../../../../lib/order/native-checkout'
import { placeNativeCheckout, placeNativeInvoiceCheckout } from '../../../../../lib/order/native-place-checkout'
import { dispatchOrderConfirmations } from '../../../../../lib/order-notifications'
import { sanitizePhoneFields } from '../../../../../lib/utils/phone'
import { assertRestaurantAcceptsDirectEntry, orderableErrorBody, staffPaymentNotConfiguredBody } from '../../../../../lib/restaurant-orderable'
import { NativePaymentNotConfiguredError } from '../../../../../lib/order/native-checkout'
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
        reference, order_number, order_status, order_type, source_of_order, is_direct_entry,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
        order_date, order_time, tax_exempt_id, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${reference}::uuid, ${orderNumber}::bigint, ${orderStatus}, ${orderType}, 'FAMILYMEAL', true,
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
/** disco_orders.is_direct_entry for one order reference. Defaults false on any error. */
async function orderIsDirectEntry(orderRef: string): Promise<boolean> {
  try {
    const r = (await sql`SELECT is_direct_entry FROM disco_orders WHERE reference = ${orderRef}::uuid LIMIT 1`) as { is_direct_entry: boolean }[]
    return r[0]?.is_direct_entry === true
  } catch { return false }
}

async function sendOrderUpdatedSlack(o: {
  orderRef: string
  restaurantRef: string
  originalTotal: number
  newTotal: number
  sourceOfOrder: string
  serviceType: string // 'P' (pickup) | 'D' (delivery)
  /** disco_orders.is_direct_entry for THIS order — read, never assumed. */
  isDirectEntry?: boolean
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
    // (DE) ONLY WHEN THE ORDER REALLY WAS DIRECT ENTRY. This was hardcoded, so
    // every order-update ping claimed direct entry regardless — including edits
    // to ordinary customer orders. A space separates the two codes: "(3D) (DE)"
    // rather than "(3D)(DE)", which scans as one token.
    const de = o.isDirectEntry === true ? ' (DE)' : ''
    const text = `update, ${place}, ${city}, ${state}, (${deltaStr} from $${orig.toFixed(2)} to $${next.toFixed(2)}), ${when} - (${o.serviceType})${de}`

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

  // Staff direct entry: archive blocks, online_ordering_enabled deliberately
  // does NOT — switching off online ordering closes the public checkout, not
  // the phone/walk-in workflow this route exists for. See
  // assertRestaurantAcceptsDirectEntry for the full reasoning.
  const directEntryOk = await assertRestaurantAcceptsDirectEntry(String(restaurantRef))
  if (!directEntryOk.orderable) {
    const { body: errBody, status } = orderableErrorBody(directEntryOk)
    return NextResponse.json(errBody, { status })
  }

  // ── THE CUSTOMER MUST BE COMPLETE, BOTH PATHS ──────────────────────────────
  // THIS ROUTE IS the direct-entry route (see the isDirectEntry note below), so
  // every order reaching it was typed by staff on someone else's behalf. There is
  // no diner profile behind these values and nothing else supplies them.
  //
  // Enforced HERE, above the native/FM split, so it covers both. The only check
  // that existed was an email test inside the native branch, so an FM-backed
  // direct entry was unvalidated entirely and a native one could still be placed
  // with no name and no phone -- which is exactly what #900000172 did.
  //
  // Server-side as well as in CheckoutDrawer because the drawer's gate is a
  // courtesy to the person typing; this is the one that holds.
  {
    const cust = (placeBody.customer ?? {}) as Record<string, unknown>
    const str = (v: unknown) => String(v ?? '').trim()
    const missing = [
      !str(cust.firstName) && 'first name',
      !str(cust.lastName) && 'last name',
      !str(cust.email) && 'email',
      !str(cust.phoneNumber).replace(/\D/g, '') && 'phone number',
    ].filter(Boolean) as string[]
    if (missing.length) {
      return NextResponse.json(
        { error: `Enter the customer's ${missing.join(', ')} before placing this order.` },
        { status: 400 },
      )
    }
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
    const wantsInvoice = String(cd.paymentMethod ?? '').toUpperCase() === 'INVOICE'
    // Native invoice (unpaid + emailed payment link) is behind a flag until the
    // fund-flow is verified in Stripe test mode — off = the prior explicit rejection.
    if (wantsInvoice && process.env.NATIVE_INVOICE_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Invoice orders aren’t available for Disco-native restaurants yet — use the Payment method.' }, { status: 400 })
    }
    const stripe = stripeClient()
    if (!stripe) return NextResponse.json({ error: 'Payment is temporarily unavailable.' }, { status: 503 })
    const cust = (placeBody.customer ?? {}) as Record<string, unknown>
    const email = String(cust.email ?? '').trim()
    if (!email) return NextResponse.json({ error: 'A customer email is required.' }, { status: 400 })

    const sharedParams = {
      restaurantReference: restaurantRef,
      customerEmail: email,
      customerFirstName: (cust.firstName as string) ?? null,
      customerLastName: (cust.lastName as string) ?? null,
      customerPhone: (cust.phoneNumber as string) ?? null,
      checkoutDetails: cd,
      deliveryAddress: placeBody.deliveryAddress,
      note: (placeBody.note as string) ?? null,
      deliveryInstructions: ((placeBody.deliveryInstructions ?? (placeBody.deliveryAddress as Record<string, unknown> | undefined)?.deliveryInstructions) ?? null) as string | null,
      companyName: (placeBody.companyName as string) ?? null,
      headcount: (placeBody.headcount ?? cd.headcount ?? null) as number | null,
      stripe,
      // ── DIRECT ENTRY, RECORDED AT THE ONE PLACE THAT KNOWS ──────────────────
      // THIS ROUTE IS the direct-entry route. It has a single client caller —
      // CheckoutDrawer, and only when ?mode=direct-entry is on the URL — and it
      // is the sole caller of assertRestaurantAcceptsDirectEntry. Reaching here
      // therefore means staff placed this on a customer's behalf; there is no
      // other way in.
      //
      // Set HERE and passed down, rather than sniffed inside the shared
      // placement module, because that module also serves the customer route
      // /api/order/place. Anything it inferred locally — the session type, which
      // cookie is present, which auth context resolved — would be an adjacent
      // fact standing in for the real one, which is the defect shape behind the
      // clone route, the password reset and the super-admin 404.
      //
      // Covers BOTH money paths: placeNativeCheckout (card) and
      // placeNativeInvoiceCheckout (invoice) receive this same object.
      isDirectEntry: true,
    }

    // ── Native INVOICE branch (M7): place UNPAID + email a Stripe invoice ──
    if (wantsInvoice) {
      let inv
      try {
        inv = await placeNativeInvoiceCheckout(sharedParams)
      } catch (e) {
        console.error('[restaurant/orders/place] native invoice placement threw:', restaurantRef, e instanceof Error ? (e.stack || e.message) : e)
        // A restaurant with no connected account is a CONFIGURATION state, not a
        // server fault, so it answers 409 with plain copy — never the assert's
        // internal sentence, which names Stripe and carries a restaurant UUID.
        // That detail stays in the server log above. In practice
        // assertRestaurantAcceptsDirectEntry already answers 409 before we get
        // here; this keeps the raw message from leaking if that ever changes.
        if (e instanceof NativePaymentNotConfiguredError) {
          const { body: errBody, status } = staffPaymentNotConfiguredBody()
          return NextResponse.json(errBody, { status })
        }
        return NextResponse.json({ error: 'Failed to create invoice order', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
      }
      if (!inv.ok) return NextResponse.json({ error: inv.error }, { status: inv.status })
      const r = inv.result

      // ── NOTIFY AT PLACEMENT, EXACTLY AS FAMILYMEAL DOES ─────────────────────
      // FM sends every channel when the INVOICE IS CREATED, not when it is paid.
      // StripeServiceImpl.createInvoice, in order, after finalize + sendInvoice:
      //
      //   emailNotificationService.sendOrderCustomerNotificationForInvoice(order)
      //       -> sendNotification(customer,   "user-order-confirm.ftl")
      //       -> sendNotification(restaurant, "restaurant-order-confirm.ftl", pdf)
      //   sendSlackNotification(order)
      //   "SEND INVOICE ORDER CONFIRMATION SMS TO RESTAURANT" -> twilioService
      //
      // Those are the SAME templates the card path uses, so an invoice order is
      // not a lesser notification — it is the identical one, sent earlier. The
      // reason is operational rather than cosmetic: the kitchen has to prepare
      // the food whether or not the invoice has been settled, and the customer
      // needs their confirmation regardless of when they pay.
      //
      // Order #900000172 is what this fixes. It sent Stripe's invoice email and
      // NOTHING else -- no customer confirmation, no restaurant email, no SMS,
      // no Slack -- because the only callers of dispatchOrderConfirmations sat on
      // payment-succeeded paths and an invoice order never reaches one at
      // placement. The restaurant had no idea the order existed.
      //
      // dispatchOrderConfirmations is claim-guarded (disco_order_events_once_uq),
      // so the invoice.payment_succeeded webhook calling it later is a no-op and
      // the customer cannot receive two confirmations for one order. FM's
      // separate invoice-paid restaurant email is kept and fires there instead --
      // see dispatchInvoicePaidRestaurantNotification.
      waitUntil(dispatchOrderConfirmations(r.orderId, 'NATIVE_INVOICE_PLACED'))

      return NextResponse.json({
        native: true, invoice: true,
        orderReference: r.orderReference,
        orderNumber: r.orderNumber,
        stripeInvoiceId: r.stripeInvoiceId,
        hostedInvoiceUrl: r.hostedInvoiceUrl,
        breakdown: r.breakdown,
      })
    }

    let outcome
    try {
      outcome = await placeNativeCheckout(sharedParams)
    } catch (e) {
      // Never swallow a native-placement failure — surface it so a live failure is
      // diagnosable instead of a bare 500 (RM4 debugging).
      console.error('[restaurant/orders/place] native placement threw:', restaurantRef, e instanceof Error ? (e.stack || e.message) : e)
      // Same configuration state as the invoice branch above — the CARD path hits
      // the identical assert, so it gets the identical 409 and the identical copy.
      if (e instanceof NativePaymentNotConfiguredError) {
        const { body: errBody, status } = staffPaymentNotConfiguredBody()
        return NextResponse.json(errBody, { status })
      }
      return NextResponse.json({ error: 'Failed to place order', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
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
          // Read the order's OWN flag rather than assuming. An edit can arrive on
          // any order, customer-placed or not, so this ping must not inherit the
          // direct-entry-ness of the route it happens to be edited through.
          isDirectEntry: await orderIsDirectEntry(String(es.orderRef ?? orderRef)),
          oldDate: optStr(es.oldDate),
          oldTime: optStr(es.oldTime),
          newDate: optStr(es.newDate),
          newTime: optStr(es.newTime),
        }))
      }
    }

    if (!res.ok) {
      console.error('[restaurant/orders/place] FM rejected place:', res.status, restaurantRef, JSON.stringify(data).slice(0, 500))
    }
    return NextResponse.json(data, { status: res.status })
  } catch (e) {
    console.error('[restaurant/orders/place] FM path threw:', e instanceof Error ? (e.stack || e.message) : e)
    return NextResponse.json({ error: 'Failed to place order', detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
