// Native (zero-FM) order lifecycle for Disco-native restaurants: price a cart
// (init) and persist a placed order (place). The actual Stripe charge is Stage 1f;
// place leaves the order in RESERVED (pre-payment), and the existing Stripe webhook
// flips RESERVED→DUE on payment_intent.succeeded.

import type Stripe from 'stripe'
import { sql, runDiscoOrderMigrations } from '../db'
import { priceNativeOrder, type Fulfillment, type NativePricedOrder } from '../pricing/native-order'
import { createNativeOrderPaymentIntent, getRestaurantPayoutConfig } from './native-payment'

export interface NativeCartItem { reference?: string; name: string; price: number; quantity: number }
export interface NativeTip { custom: boolean; amount?: number; pct?: number }
export interface NativeDeliveryAddressInput {
  addressLine1?: string; addressLine2?: string; city?: string; state?: string
  zip?: string; zipcode?: string; latitude?: number; longitude?: number
}

export interface NativeCheckoutInput {
  restaurantReference: string
  customerEmail: string
  fulfillment: Fulfillment
  items: NativeCartItem[]
  tip?: NativeTip
  deliveryFee?: number
  discountPct?: number
  scPct?: number
}

export interface NativePlaceInput extends NativeCheckoutInput {
  customerFirstName?: string
  customerLastName?: string
  customerPhone?: string
  orderDate: string  // yyyy-mm-dd
  orderTime: string  // HH:mm
  deliveryAddress?: NativeDeliveryAddressInput
  note?: string | null
  companyName?: string | null
  persons?: number | null
}

// Whether a restaurant reference is a Disco-native restaurant (no FM record).
// Native restaurants must never hit FM — the order routes branch on this.
export async function isDiscoNativeRestaurant(ref: string): Promise<boolean> {
  if (!ref) return false
  const rows = (await sql`
    SELECT 1 FROM disco_restaurant_cache
    WHERE restaurant_reference = ${ref} AND is_disco_native = true LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length > 0
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function cartSubtotal(items: NativeCartItem[]): number {
  return round2((items || []).reduce((s, it) => s + (Number(it.price) || 0) * Math.max(1, Math.trunc(Number(it.quantity) || 1)), 0))
}

// Price a native cart. Returns the full cent-exact breakdown (customer `total`,
// restaurant `transfer`, and every withheld component). No persistence.
export async function priceNativeCheckout(input: NativeCheckoutInput): Promise<NativePricedOrder & { subtotal: number }> {
  const subtotal = cartSubtotal(input.items)
  const breakdown = await priceNativeOrder({
    restaurantReference: input.restaurantReference,
    customerEmail: input.customerEmail,
    subtotal,
    fulfillment: input.fulfillment,
    deliveryFee: input.deliveryFee,
    scPct: input.scPct,
    tip: input.tip ?? { custom: false, pct: 0 },
    discountPct: input.discountPct,
  })
  return { ...breakdown, subtotal }
}

// ── Client (FM-DTO) adapter for the pricing preview ──────────────────────────
// The customer checkout (CheckoutDrawer/buildCheckoutPayload) sends an FM-shaped
// DTO to /api/order/init|update. For a Disco-native restaurant we price it in Neon
// and return the SAME FM response shape (data.checkoutPublicResponseDto) the client
// already reads (extractFmMoney), so no client changes are needed for pricing.
// NOTE: the customer-facing TOTAL does not depend on lead-gen (that's withheld from
// the restaurant payout), so pricing needs no customer session — safe for previews.

interface FmDtoAddOn { price?: number; count?: number }
interface FmDtoItem { reference?: string; name?: string; price?: number; count?: number; extraItems?: FmDtoAddOn[] }

// Map FM-shaped checkout items → native cart items, folding each line's add-on
// prices into the unit price and count→quantity, so cartSubtotal is consistent
// with fmDtoSubtotal (the pricing preview) and with FM's line math.
export function fmItemsToNativeCart(items: FmDtoItem[] | undefined): NativeCartItem[] {
  return (items || []).map((it, i) => {
    const addOns = Array.isArray(it.extraItems)
      ? it.extraItems.reduce((a, e) => a + (Number(e.price) || 0) * Math.max(1, Math.trunc(Number(e.count) || 1)), 0)
      : 0
    return {
      reference: it.reference,
      name: it.name || `item-${i}`,
      price: (Number(it.price) || 0) + addOns,
      quantity: Math.max(1, Math.trunc(Number(it.count) || 1)),
    }
  })
}

export function fmDtoSubtotal(items: FmDtoItem[] | undefined): number {
  return round2((items || []).reduce((sum, it) => {
    const addOns = Array.isArray(it.extraItems)
      ? it.extraItems.reduce((a, e) => a + (Number(e.price) || 0) * Math.max(1, Math.trunc(Number(e.count) || 1)), 0)
      : 0
    const unit = (Number(it.price) || 0) + addOns
    const qty = Math.max(1, Math.trunc(Number(it.count) || 1))
    return sum + unit * qty
  }, 0))
}

// Price an FM-shaped checkout DTO for a native restaurant and return the FM
// response envelope the client already understands. Delivery is third-party (Disco
// uses Expedite for all delivery); own-delivery + real delivery fees arrive with
// Stage 6 settings.
export async function priceNativeFmDto(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const orderType = String(body?.orderType || 'PICKUP')
  const tipsType = String(body?.tipsType || 'PERCENTAGE')
  const tips = Number(body?.tips) || 0
  const subtotal = fmDtoSubtotal(body?.items as FmDtoItem[])
  const b = await priceNativeOrder({
    restaurantReference: String(body?.restaurantRef || body?.restaurantReference || ''),
    customerEmail: '', // total is lead-gen-independent; place() resolves the real customer
    subtotal,
    fulfillment: orderType === 'DELIVERY' ? 'THIRD_PARTY_DELIVERY' : 'PICKUP',
    deliveryFee: 0,
    scPct: Number(body?.serviceChargePct) || 0,
    tip: tipsType === 'CUSTOM' ? { custom: true, amount: tips } : { custom: false, pct: tips },
  })
  const deliveryFee = 0
  const tipsInPrice = round2(b.tipsInPrice + b.thirdPartyDeliveryTips)
  return {
    native: true,
    data: {
      orderReference: 'native',
      checkoutPublicResponseDto: {
        subtotal,
        fee: b.familyMealFee,
        serviceCharge: b.serviceCharge,
        stateSalesTaxInPrice: b.stateTax,
        localSalesTaxInPrice: b.localTax,
        otherSalesTaxInPrice: b.otherTax,
        deliveryFee,
        tipsInPrice,
        discount: b.discount,
        total: b.total,
      },
    },
  }
}

async function nextNativeOrderNumber(): Promise<number> {
  const rows = (await sql`SELECT nextval('disco_native_order_seq')::bigint AS n`) as { n: string | number }[]
  return Number(rows[0].n)
}

function fulfillmentToTypes(f: Fulfillment): { orderType: 'PICKUP' | 'DELIVERY'; deliveryType: string | null } {
  if (f === 'PICKUP') return { orderType: 'PICKUP', deliveryType: 'PICKUP' }
  if (f === 'OWN_DELIVERY') return { orderType: 'DELIVERY', deliveryType: 'OWN_DELIVERY' }
  return { orderType: 'DELIVERY', deliveryType: 'THIRD_PARTY_DELIVERY' }
}

export interface NativePlaceResult {
  orderId: number
  orderReference: string
  orderNumber: number
  breakdown: NativePricedOrder & { subtotal: number }
}

// Persist a placed native order: disco_orders (RESERVED) + disco_sale_transactions
// (INITIATED) with the full cent-exact breakdown. Zero FM. Payment (1f) creates the
// PaymentIntent and the webhook flips the order to DUE.
export async function placeNativeOrder(input: NativePlaceInput): Promise<NativePlaceResult> {
  await runDiscoOrderMigrations()
  const b = await priceNativeCheckout(input)
  const { orderType, deliveryType } = fulfillmentToTypes(input.fulfillment)
  const orderNumber = await nextNativeOrderNumber()

  const fee = input.deliveryFee ?? 0
  const ownDeliveryFee = input.fulfillment === 'OWN_DELIVERY' ? fee : 0
  const thirdPartyDeliveryFee = input.fulfillment === 'THIRD_PARTY_DELIVERY' ? fee : 0
  const tipsTotal = round2(b.tipsInPrice + b.thirdPartyDeliveryTips)
  const da = input.deliveryAddress ?? {}
  const daZip = da.zip ?? da.zipcode ?? null
  const daLat = typeof da.latitude === 'number' ? da.latitude : null
  const daLng = typeof da.longitude === 'number' ? da.longitude : null

  const orderRows = (await sql`
    INSERT INTO disco_orders (
      order_number, order_status, order_type, delivery_type, source_of_order,
      restaurant_reference, customer_email, customer_first_name, customer_last_name, customer_phone,
      order_date, order_time, tips, tips_type,
      delivery_address_line1, delivery_address_line2, delivery_city, delivery_state, delivery_zip,
      delivery_lat, delivery_lng, subtotal, total, fee, note, company_name, persons, created_at, updated_at
    ) VALUES (
      ${orderNumber}::bigint, 'RESERVED', ${orderType}, ${deliveryType}, 'DISCO',
      ${input.restaurantReference}::uuid, ${input.customerEmail}, ${input.customerFirstName ?? null}, ${input.customerLastName ?? null}, ${input.customerPhone ?? null},
      ${input.orderDate}::date, ${input.orderTime}::time, ${tipsTotal}, ${input.tip?.custom ? 'CUSTOM' : 'PERCENTAGE'},
      ${da.addressLine1 ?? null}, ${da.addressLine2 ?? null}, ${da.city ?? null}, ${da.state ?? null}, ${daZip},
      ${daLat}, ${daLng}, ${b.subtotal}, ${b.total}, ${b.familyMealFee}, ${input.note ?? null}, ${input.companyName ?? null}, ${input.persons ?? null}, NOW(), NOW()
    )
    RETURNING id, reference, order_number
  `) as { id: number; reference: string; order_number: string | number }[]
  const order = orderRows[0]

  // Full breakdown → disco_sale_transactions (the money-of-record row the portal
  // dashboards read). money_flow DIRECT: restaurant is merchant-of-record.
  await sql`
    INSERT INTO disco_sale_transactions (
      order_id, transaction_status, transaction_type, subtotal, total, fee, service_charge, stripe_fee,
      state_tax, local_tax, other_tax, tips_in_price, third_party_delivery_tips,
      own_delivery_fee, third_party_delivery_fee, third_party_delivery_subsiding, discount,
      lead_gen_one_disco_fee, lead_gen_two_disco_fee, money_flow, created_at, updated_at
    ) VALUES (
      ${order.id}, 'INITIATED', 'ORIGINAL', ${b.subtotal}, ${b.total}, ${b.familyMealFee}, ${b.serviceCharge}, ${b.stripeFee},
      ${b.stateTax}, ${b.localTax}, ${b.otherTax}, ${b.tipsInPrice}, ${b.thirdPartyDeliveryTips},
      ${ownDeliveryFee}, ${thirdPartyDeliveryFee}, ${0}, ${b.discount},
      ${b.leadGenTier === 1 ? b.leadGen : 0}, ${b.leadGenTier === 2 ? b.leadGen : 0}, 'DIRECT', NOW(), NOW()
    )
  `

  return { orderId: order.id, orderReference: order.reference, orderNumber: Number(order.order_number), breakdown: b }
}

export interface NativePlaceAndPayResult extends NativePlaceResult {
  paymentIntentId: string
  clientSecret: string | null
  withheld: boolean
}

// Place a native order AND create its PaymentIntent (destination charge). The PI is
// created UNCONFIRMED (client_secret returned) for the browser to confirm with
// Stripe.js; the existing Stripe webhook flips the order RESERVED→DUE on
// payment_intent.succeeded (it looks the order up via disco_stripe_payments).
export async function placeAndPayNativeOrder(
  input: NativePlaceInput,
  stripe: Stripe,
  opts?: { customerId?: string; onBehalfOf?: boolean },
): Promise<NativePlaceAndPayResult> {
  const placed = await placeNativeOrder(input)
  const pay = await getRestaurantPayoutConfig(input.restaurantReference)
  const pi = await createNativeOrderPaymentIntent(stripe, {
    totalDollars: placed.breakdown.total,
    transferDollars: placed.breakdown.transfer,
    connectedAccountId: pay.connectedAccountId,
    withholdPayouts: pay.withholdPayouts,
    customerId: opts?.customerId,
    onBehalfOf: opts?.onBehalfOf ?? true, // production: restaurant is merchant-of-record
    metadata: { orderReference: placed.orderReference, orderNumber: String(placed.orderNumber), kind: 'native_order' },
    description: `Disco Cater order #${placed.orderNumber}`,
  })
  // Link the PaymentIntent → order so the webhook can find and complete it.
  await sql`
    INSERT INTO disco_stripe_payments (order_reference, restaurant_reference, stripe_payment_intent_id, status, subtotal, total, created_at)
    VALUES (${placed.orderReference}::uuid, ${input.restaurantReference}::uuid, ${pi.id}, 'INITIATED', ${placed.breakdown.subtotal}, ${placed.breakdown.total}, NOW())
    ON CONFLICT (stripe_payment_intent_id) DO NOTHING
  `
  await sql`UPDATE disco_sale_transactions SET stripe_payment_intent_id = ${pi.id} WHERE order_id = ${placed.orderId}`
  return { ...placed, paymentIntentId: pi.id, clientSecret: pi.client_secret, withheld: pay.withholdPayouts || !pay.connectedAccountId }
}
