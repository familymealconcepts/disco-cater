import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { randomUUID } from 'node:crypto'
import Stripe from 'stripe'
import { getFmCustomerJwt } from '../../../../lib/customer-auth'
import { sanitizePhoneFields } from '../../../../lib/utils/phone'
import { sql } from '../../../../lib/db'
import { fmFetch } from '../../../../lib/fm-fetch'
import { applyRestaurantFundedDiscount, type ApplyResult } from '../../../../lib/promo-apply'
import { geocodeAddress } from '../../../../lib/geocode'
import { isDiscoNativeRestaurant, placeNativeOrder } from '../../../../lib/order/native-checkout'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function stripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
}

// Pull the FM-created PaymentIntent id off the place response (nested under
// data.paymentDetails.stripePaymentIntentDto, or flat on some envelopes).
function extractPaymentIntentId(data: Record<string, unknown>): string {
  const fmInner = ((data?.data ?? data ?? {}) as Record<string, unknown>)
  const paymentDetails = (fmInner.paymentDetails ?? data.paymentDetails ?? {}) as Record<string, unknown>
  const stripeIntent = (paymentDetails.stripePaymentIntentDto ?? {}) as Record<string, unknown>
  const id = stripeIntent.paymentIntentId
  return typeof id === 'string' ? id : ''
}

// Delivery-address geocoding now uses the shared, Mapbox-preferred geocoder
// (lib/geocode) — the same one the native checkout uses — so both the FM-mirror
// and native paths geocode via a working provider instead of the disabled Google
// Geocoding API. Best-effort: nulls never block the order mirror.

// Read the restaurant's delivery time-window setting (deliveryOrderTimeWindows:
// 'exact' | '30_min' | '1_hour') from the FM public restaurant DTO — the
// authoritative, current value. Best-effort: null on any failure. Only fetched
// for DELIVERY orders; PICKUP always stores null (exact time).
async function fetchDeliveryTimeWindow(restaurantRef: string): Promise<string | null> {
  try {
    const res = await fetch(`${FM}/public-api/restaurants/${restaurantRef}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    const w = data?.deliveryOrderTimeWindows
    return typeof w === 'string' && w ? w : null
  } catch (e) {
    console.error('[order/place] deliveryOrderTimeWindows fetch failed:', e instanceof Error ? e.message : e)
    return null
  }
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
  // When tax exempt, the actual charge (reduced PaymentIntent amount, in dollars)
  // — stored as the order total so the confirmation page + receipts match.
  taxExemptCharge?: number | null
  // Disco-only company name (not part of the FM payload).
  companyName?: string | null
  // Disco-only order note (e.g. "Include utensils") — not part of the FM payload.
  note?: string | null
  // Disco-only tax-exempt US state (not part of the FM payload).
  taxExemptState?: string | null
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
    // Disco uses Expedite for all third-party delivery; PICKUP otherwise.
    const deliveryType = orderType === 'DELIVERY' ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'
    // Persist the delivery address so the Expedite dropoff task (created at
    // confirm-payment) has a real destination.
    const da = (placeBody.deliveryAddress ?? {}) as Record<string, unknown>
    const daLine1 = str(da.addressLine1)
    const daLine2 = str(da.addressLine2)
    const daCity = str(da.city)
    const daState = str(da.state)
    const daZip = str(da.zipcode ?? da.zip)
    const statusRaw = String(fmInner.orderStatus ?? fm.orderStatus ?? fmInner.status ?? '').toUpperCase()
    const orderStatus = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'DUE'
    const money = extractMoney(fmInner)
    const { subtotal, fee } = money
    // Tax exempt → persist the reduced charge (matches the PaymentIntent + the
    // amount the customer is actually charged), not FM's tax-inclusive total.
    const total = args.taxExemptCharge != null ? args.taxExemptCharge : money.total
    // Tax-exempt id (Item 4) — sent on checkoutDetails; persisted so the
    // confirmation page, PDF, drawer, and emails can show it.
    const taxExemptId = str(checkoutDetails.taxExemptId)
    // Disco-only company name — never part of the FM DTO; mirror it here.
    const companyName = str(args.companyName)
    // Disco-only order note (utensils) — mirror onto disco_orders.note.
    const note = str(args.note)
    // Disco-only tax-exempt state — never part of the FM DTO; mirror it here.
    const taxExemptState = str(args.taxExemptState)
    // Headcount — FM has no order-level field, so it's sent on the place body
    // (or, where FM ever provides one, read off the FM payload). null when absent.
    const personsRaw = placeBody.headcount ?? checkoutDetails.headcount ?? fmInner.persons ?? fmInner.numberOfPeople
    const persons = Number.isInteger(Number(personsRaw)) && Number(personsRaw) > 0 ? Number(personsRaw) : null

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

    // Geocode the delivery address so the Expedite dropoff task has accurate
    // lat/lng. Prefer coordinates the client already validated (Mapbox), else
    // geocode via Google. Best-effort — NULL when unavailable.
    let deliveryLat: number | null = null
    let deliveryLng: number | null = null
    if (orderType === 'DELIVERY') {
      const cLat = Number(da.latitude)
      const cLng = Number(da.longitude)
      if (Number.isFinite(cLat) && Number.isFinite(cLng) && (cLat !== 0 || cLng !== 0)) {
        deliveryLat = cLat; deliveryLng = cLng
      } else {
        const fullAddress = [daLine1, daLine2, daCity, daState, daZip].filter(Boolean).join(', ')
        const geo = await geocodeAddress(fullAddress)
        deliveryLat = geo.lat; deliveryLng = geo.lng
      }
    }

    // Snapshot the restaurant's delivery time-window setting so the confirmation
    // page + emails can render the delivery time as a range. DELIVERY only.
    const deliveryTimeWindow = orderType === 'DELIVERY' ? await fetchDeliveryTimeWindow(restaurantRef) : null

    // (a) disco_orders — upsert keyed by the FM order reference (== reference here),
    // DO UPDATE so retries refresh the money snapshot. RETURNING id for items.
    const orderRows = (await sql`
      INSERT INTO disco_orders (
        reference, order_number, order_status, order_type, delivery_type, source_of_order,
        restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
        delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
        delivery_lat, delivery_lng, delivery_time_window,
        order_date, order_time, subtotal, total, fee, tax_exempt_id, tax_exempt_state, company_name, note, persons, fm_order_reference, created_at, updated_at
      ) VALUES (
        ${reference}::uuid, ${orderNumber}::bigint, ${orderStatus}, ${orderType}, ${deliveryType}, 'DISCO',
        ${restaurantRef}::uuid, ${customerEmail}, ${str(customer.firstName)}, ${str(customer.lastName)}, ${str(customer.phoneNumber)},
        ${daLine1}, ${daLine2}, ${daCity}, ${daState}, ${daZip},
        ${deliveryLat}, ${deliveryLng}, ${deliveryTimeWindow},
        ${orderDate}::date, ${orderTime}::time, ${subtotal}, ${total}, ${fee}, ${taxExemptId}, ${taxExemptState}, ${companyName}, ${note || null}, ${persons}, ${reference}::uuid, NOW(), NOW()
      )
      ON CONFLICT (reference) DO UPDATE SET
        subtotal = EXCLUDED.subtotal, total = EXCLUDED.total, fee = EXCLUDED.fee,
        company_name = COALESCE(EXCLUDED.company_name, disco_orders.company_name),
        note = COALESCE(EXCLUDED.note, disco_orders.note),
        tax_exempt_state = COALESCE(EXCLUDED.tax_exempt_state, disco_orders.tax_exempt_state),
        order_status = EXCLUDED.order_status, fm_order_reference = EXCLUDED.fm_order_reference,
        delivery_type = EXCLUDED.delivery_type,
        delivery_address_line1 = COALESCE(EXCLUDED.delivery_address_line1, disco_orders.delivery_address_line1),
        delivery_address_line2 = COALESCE(EXCLUDED.delivery_address_line2, disco_orders.delivery_address_line2),
        delivery_city = COALESCE(EXCLUDED.delivery_city, disco_orders.delivery_city),
        delivery_state = COALESCE(EXCLUDED.delivery_state, disco_orders.delivery_state),
        delivery_zip = COALESCE(EXCLUDED.delivery_zip, disco_orders.delivery_zip),
        delivery_lat = COALESCE(EXCLUDED.delivery_lat, disco_orders.delivery_lat),
        delivery_lng = COALESCE(EXCLUDED.delivery_lng, disco_orders.delivery_lng),
        delivery_time_window = COALESCE(EXCLUDED.delivery_time_window, disco_orders.delivery_time_window),
        tax_exempt_id = COALESCE(EXCLUDED.tax_exempt_id, disco_orders.tax_exempt_id),
        persons = COALESCE(EXCLUDED.persons, disco_orders.persons), updated_at = NOW()
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
    const body = await req.json()

    // ── Disco-native path: persist the order entirely in Neon (zero FM). No FM JWT
    // needed — native customers authenticate via the Disco session. The Stripe
    // charge is Stage 1f; place leaves the order RESERVED. ──
    if (body?.restaurantRef && await isDiscoNativeRestaurant(body.restaurantRef)) {
      const result = await placeNativeOrder({
        restaurantReference: body.restaurantRef,
        customerEmail: String(body?.customerEmail || body?.customer?.email || ''),
        customerFirstName: body?.customer?.firstName ?? body?.customerFirstName,
        customerLastName: body?.customer?.lastName ?? body?.customerLastName,
        customerPhone: body?.customer?.phoneNumber ?? body?.customerPhone,
        fulfillment: body?.fulfillment || (body?.deliveryAddress ? 'THIRD_PARTY_DELIVERY' : 'PICKUP'),
        items: Array.isArray(body?.items) ? body.items : [],
        tip: body?.tip,
        deliveryFee: body?.deliveryFee,
        discountPct: body?.discountPct,
        scPct: body?.scPct,
        orderDate: String(body?.orderDate || body?.checkoutDetails?.orderDate || ''),
        orderTime: String(body?.orderTime || body?.checkoutDetails?.orderTime || ''),
        deliveryAddress: body?.deliveryAddress,
        note: body?.note ?? null,
        companyName: body?.companyName ?? null,
        persons: body?.persons ?? body?.headcount ?? null,
      })
      return NextResponse.json({ native: true, orderReference: result.orderReference, orderNumber: result.orderNumber, breakdown: result.breakdown })
    }

    const token = await getFmCustomerJwt(req)
    // Vercel log: surface whether the FM JWT resolved (never log the token).
    console.log('[order/place] FM JWT present:', !!token)
    if (!token) {
      console.warn('[order/place] No FM JWT — order will NOT be placed. Customer must be logged in with a valid FM session.')
      return NextResponse.json({ error: 'Authentication required. Please log in again.' }, { status: 401 })
    }

    // taxExemptApplied / taxAmount are Disco-only directives — pull them OUT of the
    // body so they're never forwarded to FM (the rest of the body, including
    // checkoutDetails + customer, is proxied to FM untouched). FM keeps the tax in
    // its total/PaymentIntent; Disco subtracts it from the PI below.
    const { restaurantRef, orderRef, taxExemptApplied, taxAmount, taxExemptState, companyName, note, restaurantPromoCode, serviceChargePct, ...placeBody } = body
    if (!restaurantRef || !orderRef) {
      return NextResponse.json({ error: 'restaurantRef and orderRef required' }, { status: 400 })
    }

    // FM rejects formatted phone numbers ("Phone number has wrong format") — it
    // wants digits only (e.g. "732-239-7055" → "7322397055"). Recursively
    // sanitize every phone field anywhere in the place payload (customer /
    // deliveryAddress / checkoutDetails) before forwarding to FM. This mutates
    // placeBody in place, so the Neon mirror below also persists digits-only.
    sanitizePhoneFields(placeBody)

    const res = await fmFetch(`${FM}/api/v2/restaurants/${restaurantRef}/orders/${orderRef}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(placeBody),
    })
    const data = await res.json()

    // FM nests the order under `data` on most responses; used below for the
    // tax-exempt recompute + PaymentIntent extraction.
    const fmInnerLog = (data?.data ?? data ?? {}) as Record<string, unknown>

    // Tax exempt → reduce the FM-created PaymentIntent by the tax amount BEFORE the
    // client calls /confirm-payment (FM charges whatever amount is on the PI). This
    // must run synchronously (awaited) so the reduced amount is live by the time the
    // next confirm call fires. Best-effort: a failure leaves the full PI in place
    // rather than blocking the order.
    let taxExemptCharge: number | null = null
    if (res.ok && taxExemptApplied === true) {
      // Recompute the tax SERVER-SIDE from FM's order response (don't trust the
      // client-supplied taxAmount). Fall back to the client value only if FM
      // didn't return tax fields.
      const taxDto = ((fmInnerLog.checkoutPublicResponseDto as Record<string, unknown>) ?? fmInnerLog) as Record<string, unknown>
      const serverTax = num(taxDto.stateSalesTaxInPrice) + num(taxDto.localSalesTaxInPrice) + num(taxDto.otherSalesTaxInPrice)
      const tax = serverTax > 0 ? serverTax : (Number(taxAmount) || 0)
      if (tax > 0) {
        const stripe = stripeClient()
        const paymentIntentId = extractPaymentIntentId(data)
        // Refuse to proceed if we can't reduce the PI — silently charging the full
        // tax-inclusive amount while the receipt shows tax-exempt is an overcharge.
        if (!stripe || !paymentIntentId) {
          console.error('[order/place] tax exempt requested but no Stripe key / PaymentIntent — refusing to overcharge')
          return NextResponse.json({ error: 'Tax exempt could not be applied. Please try again or proceed without tax exemption.' }, { status: 502 })
        }
        try {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId)
          const originalTotal = (pi.amount ?? 0) / 100 // authoritative charge amount (incl. tax), in dollars
          const newAmount = Math.max(0, Math.round((originalTotal - tax) * 100)) // integer cents
          await stripe.paymentIntents.update(paymentIntentId, { amount: newAmount })
          taxExemptCharge = newAmount / 100
          console.log(`[order/place] Tax exempt applied (serverTax=${serverTax}, used=${tax}) — PI from $${originalTotal.toFixed(2)} to $${taxExemptCharge.toFixed(2)}`)
        } catch (e) {
          console.error('[order/place] tax-exempt PI update failed:', e instanceof Error ? e.message : e)
          return NextResponse.json({ error: 'Tax exempt could not be applied. Please try again or proceed without tax exemption.' }, { status: 502 })
        }
      }
    }

    // Restaurant-funded promo (Path B): recompute FM's DISCOUNTED total + restaurant
    // transfer and adjust the FM-created PaymentIntent PRE-CHARGE — so the customer
    // is charged the discounted total and the restaurant's transfer is naturally
    // smaller (no refund/reversal). Skipped for tax-exempt orders (the PI was already
    // adjusted above; the promo self-check would fail — safe). A self-check failure
    // or un-mirrored tax rates → refuse rather than charge the wrong amount.
    let restaurantPromoApplied: ApplyResult | null = null
    if (res.ok && typeof restaurantPromoCode === 'string' && restaurantPromoCode.trim() && taxExemptApplied !== true) {
      const stripe = stripeClient()
      const paymentIntentId = extractPaymentIntentId(data)
      if (!stripe || !paymentIntentId) {
        console.error('[order/place] restaurant promo requested but no Stripe key / PaymentIntent — refusing to charge full price')
        return NextResponse.json({ error: 'Promo code could not be applied. Please remove it and try again.' }, { status: 502 })
      }
      const fmCheckout = ((fmInnerLog.checkoutPublicResponseDto as Record<string, unknown>) ?? fmInnerLog) as Record<string, unknown>
      try {
        const pb = placeBody as Record<string, unknown>
        const cust = (pb.customer ?? {}) as Record<string, unknown>
        const email = String(cust.email || pb.email || '').trim().toLowerCase()
        restaurantPromoApplied = await applyRestaurantFundedDiscount({
          stripe, paymentIntentId, restaurantRef, code: restaurantPromoCode.trim().toUpperCase(),
          serviceChargePct: Number(serviceChargePct) || 0,
          orderType: String(pb.orderType || '').toUpperCase() === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
          fmCheckout, orderRef, userEmail: email,
        })
      } catch (e) {
        console.error('[order/place] restaurant promo apply error:', e instanceof Error ? e.message : e)
        return NextResponse.json({ error: 'Promo code could not be applied. Please remove it and try again.' }, { status: 502 })
      }
      if (!restaurantPromoApplied.applied) {
        console.error('[order/place] restaurant promo NOT applied:', restaurantPromoApplied.reason, 'code', restaurantPromoCode)
        return NextResponse.json({ error: 'Promo code could not be applied. Please remove it and try again.' }, { status: 502 })
      }
      console.log(`[order/place] restaurant promo ${restaurantPromoCode} applied (${restaurantPromoApplied.moneyFlow}): charge $${restaurantPromoApplied.newAmount?.toFixed(2)}, transfer ${restaurantPromoApplied.newTransfer != null ? '$' + restaurantPromoApplied.newTransfer.toFixed(2) : 'n/a'}`)
    }

    // Mirror into Neon only after FM accepted the order. Fire-and-forget via
    // waitUntil — non-blocking and never affects the response below.
    if (res.ok) {
      waitUntil(mirrorOrderToNeon({ restaurantRef, orderRef, placeBody, fmData: data, taxExemptCharge, companyName: typeof companyName === 'string' ? companyName : null, taxExemptState: typeof taxExemptState === 'string' ? taxExemptState : null, note: typeof note === 'string' ? note : null }))
    }

    // Surface the tax-exempt-adjusted charge so the frontend knows the real amount.
    if (taxExemptCharge != null && data && typeof data === 'object' && !Array.isArray(data)) {
      data.taxExemptApplied = true
      data.taxExemptCharge = taxExemptCharge
    }
    // Surface the restaurant-funded promo result so the confirmation UI shows the
    // discounted charge (the PI was adjusted pre-charge; confirm charges this).
    if (restaurantPromoApplied?.applied && data && typeof data === 'object' && !Array.isArray(data)) {
      data.restaurantPromoApplied = true
      data.restaurantPromoCharge = restaurantPromoApplied.newAmount
      data.restaurantPromoDiscountPct = restaurantPromoApplied.discountPct
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to place order' }, { status: 500 })
  }
}
