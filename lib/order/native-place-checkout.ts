import type Stripe from 'stripe'
import {
  fmItemsToNativeCart, isNativeOrderingOpen, isNativeDateClosed, isNativeDailyCapReached,
  isNativeDateTimeValid, loadRestaurantServiceChargePct, placeAndPayNativeOrder, placeNativeInvoiceOrder,
  priceNativeCart, type NativePlaceAndPayResult, type NativeInvoiceResult, type NativePlaceInput,
  type NativeDeliveryAddressInput,
} from './native-checkout'
import { checkItemInventoryAvailability } from './native-inventory'
import { recordNativeRestaurantPromoUse, type NativePromoResolution } from '../promo-native'

export type NativeCheckoutOutcome =
  | { ok: true; result: NativePlaceAndPayResult }
  | { ok: false; status: number; error: string }

export type NativeInvoiceCheckoutOutcome =
  | { ok: true; result: NativeInvoiceResult }
  | { ok: false; status: number; error: string }

export interface NativeCheckoutParams {
  restaurantReference: string
  customerEmail: string
  customerFirstName?: string | null
  customerLastName?: string | null
  customerPhone?: string | null
  // The priced checkout DTO — orderDate (DD.MM.YYYY or ISO), orderTime, orderType,
  // tips, tipsType, items — exactly as CheckoutDrawer sends it.
  checkoutDetails: Record<string, unknown>
  deliveryAddress?: unknown
  note?: string | null
  deliveryInstructions?: string | null
  companyName?: string | null
  headcount?: number | null
  // Restaurant-funded promo code (M6). Applied only when it resolves to a valid
  // RESTAURANT-funded percent code for this restaurant; otherwise ignored.
  restaurantPromoCode?: string | null
  stripe: Stripe
  savedOpts?: { customerId?: string }
}

interface BuiltNativeOrder { input: NativePlaceInput; promo: NativePromoResolution | null }
type BuildOutcome = { ok: true; built: BuiltNativeOrder } | { ok: false; status: number; error: string }

// Shared prelude for BOTH native money paths (card charge + invoice): the
// ordering-open / closed-date gates, authoritative fulfillment + delivery fee, item
// mapping, and restaurant-funded promo resolution. Producing the SAME NativePlaceInput
// for both paths is what keeps them from drifting. Callers pick the terminal action.
async function buildNativePlaceInput(params: NativeCheckoutParams): Promise<BuildOutcome> {
  const ref = params.restaurantReference
  const cd = params.checkoutDetails || {}

  // Online-ordering hard gate: a paused restaurant can never take an order.
  if (!(await isNativeOrderingOpen(ref))) {
    return { ok: false, status: 403, error: 'This restaurant is not currently accepting online orders.' }
  }
  // Closed-date backup for the Closed Days / Holidays block.
  const rawDate = String(cd.orderDate ?? '')
  const dmDate = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(rawDate)
  const orderDate = dmDate ? `${dmDate[3]}-${dmDate[2]}-${dmDate[1]}` : rawDate
  if (await isNativeDateClosed(ref, orderDate)) {
    return { ok: false, status: 403, error: 'This restaurant is closed on the selected date.' }
  }
  // Daily order-capacity gate (max_orders_per_day) — checked right after the
  // date-level gates, before any pricing/promo/delivery work happens.
  if (await isNativeDailyCapReached(ref, orderDate)) {
    return { ok: false, status: 409, error: 'This restaurant has reached its maximum number of orders for the selected date. Please choose a different date.' }
  }
  // Re-validate the requested date+time against the SAME scheduling rules the
  // checkout UI enforces (lead time, day-of-week window, Custom date-range
  // availability, skipped days) — the picker only hides invalid options, it
  // doesn't stop a direct API call from requesting one.
  const orderTime = String(cd.orderTime ?? '')
  if (!(await isNativeDateTimeValid(ref, orderDate, orderTime))) {
    return { ok: false, status: 400, error: 'The selected date/time is no longer available for this menu. Please choose a different date or time.' }
  }

  // 1P vs 3P attribution — the SAME signal the client sends the FM path
  // (CheckoutDrawer sets 'FAMILYMEAL' for the /order/{slug} 1P Direct link, 'DISCO'
  // for the /restaurants/{slug} marketplace link). Only an EXPLICIT 'FAMILYMEAL'
  // suppresses the lead-gen fee; anything else (incl. an absent value) is treated
  // as 'DISCO' — native's historical default, so a lost signal errs toward charging
  // the marketplace fee rather than silently giving it away.
  const sourceOfOrder: 'DISCO' | 'FAMILYMEAL' =
    String(cd.sourceoforder ?? '').toUpperCase() === 'FAMILYMEAL' ? 'FAMILYMEAL' : 'DISCO'

  const orderTypeRaw = String(cd.orderType ?? (params.deliveryAddress ? 'DELIVERY' : 'PICKUP'))
  const tips = Number(cd.tips) || 0
  const tipsType = String(cd.tipsType ?? 'PERCENTAGE')
  const items = fmItemsToNativeCart(cd.items as Parameters<typeof fmItemsToNativeCart>[0])

  // Per-item daily inventory cap (Max Inventory Per Day) — a best-effort
  // pre-payment check so an obviously-oversold cart is blocked before the
  // customer enters payment info. Only items with a cap set are inspected;
  // uncapped items skip this entirely. The real enforcement is the atomic
  // decrement at payment success (lib/order/native-inventory.ts).
  const capCheck = await checkItemInventoryAvailability(items, orderDate)
  if (!capCheck.ok) {
    const msg = capCheck.remaining > 0
      ? `Only ${capCheck.remaining} left of "${capCheck.itemName}" for ${orderDate} — please reduce the quantity.`
      : `"${capCheck.itemName}" is no longer available for ${orderDate}.`
    return { ok: false, status: 409, error: msg }
  }

  const tip = tipsType === 'CUSTOM' ? { custom: true, amount: tips } : { custom: false, pct: tips }

  // Resolve the promo + fulfillment + delivery fee TOGETHER, off the discounted
  // subtotal — priceNativeCart is the exact same function the pricing preview
  // calls (native-checkout.ts), so what the customer saw before placing cannot
  // drift from what's charged here. Its own breakdown is discarded below (the
  // authoritative persisted breakdown still comes from placeAndPayNativeOrder's
  // own priceNativeCheckout call) — this call exists only to resolve promo/
  // fulfillment/deliveryFee/thirdPartyDeliverySubsiding through the single path.
  const priced = await priceNativeCart({
    restaurantReference: ref,
    customerEmail: params.customerEmail,
    items,
    orderType: orderTypeRaw === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
    deliveryAddress: params.deliveryAddress as NativeDeliveryAddressInput | undefined,
    tip,
    restaurantPromoCode: params.restaurantPromoCode,
    sourceOfOrder,
  })
  if (!priced.deliveryValid) {
    return { ok: false, status: 400, error: priced.deliveryMessage || 'That delivery address is not serviceable.' }
  }
  const promo = priced.promo

  const input: NativePlaceInput = {
    restaurantReference: ref,
    sourceOfOrder,
    customerEmail: params.customerEmail,
    customerFirstName: params.customerFirstName ?? undefined,
    customerLastName: params.customerLastName ?? undefined,
    customerPhone: params.customerPhone ?? undefined,
    fulfillment: priced.fulfillment,
    items,
    tip,
    deliveryFee: priced.deliveryFee,
    thirdPartyDeliverySubsiding: priced.thirdPartyDeliverySubsiding,
    discountPct: promo?.pct ?? 0,
    scPct: await loadRestaurantServiceChargePct(ref),
    orderDate,
    orderTime,
    deliveryAddress: params.deliveryAddress as NativePlaceInput['deliveryAddress'],
    note: params.note ?? null,
    deliveryInstructions: params.deliveryInstructions ?? null,
    companyName: params.companyName ?? null,
    persons: params.headcount ?? null,
  }
  return { ok: true, built: { input, promo } }
}

// Shared Disco-native order placement for BOTH the customer flow
// (/api/order/place) and Direct Entry (/api/restaurant/orders/place). Card path:
// places + creates the PaymentIntent for the browser to confirm; the webhook flips
// RESERVED→DUE on success. Returns a discriminated result.
export async function placeNativeCheckout(params: NativeCheckoutParams): Promise<NativeCheckoutOutcome> {
  const b = await buildNativePlaceInput(params)
  if (!b.ok) return b
  const { input, promo } = b.built

  const result = await placeAndPayNativeOrder(input, params.stripe, params.savedOpts)

  if (promo) {
    await recordNativeRestaurantPromoUse({
      promoId: promo.id, orderRef: result.orderReference, userEmail: params.customerEmail,
      discountDollars: result.breakdown.discount, restaurantRef: input.restaurantReference,
      paymentIntentId: result.paymentIntentId,
    })
  }
  return { ok: true, result }
}

// M7 — invoice path: place the order UNPAID and bill the customer via a Stripe
// invoice (no PaymentIntent, no card confirm). Same gates/pricing as the card path.
export async function placeNativeInvoiceCheckout(params: NativeCheckoutParams): Promise<NativeInvoiceCheckoutOutcome> {
  const b = await buildNativePlaceInput(params)
  if (!b.ok) return b
  const { input, promo } = b.built

  const result = await placeNativeInvoiceOrder(input, params.stripe)

  if (promo) {
    await recordNativeRestaurantPromoUse({
      promoId: promo.id, orderRef: result.orderReference, userEmail: params.customerEmail,
      discountDollars: result.breakdown.discount, restaurantRef: input.restaurantReference,
      paymentIntentId: null,
    })
  }
  return { ok: true, result }
}
