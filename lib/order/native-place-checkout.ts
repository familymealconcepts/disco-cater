import type Stripe from 'stripe'
import {
  fmItemsToNativeCart, isNativeOrderingOpen, isNativeDateClosed, isNativeDailyCapReached,
  isNativeDateTimeValid, loadRestaurantServiceChargePct, loadMenuFulfillmentAvailability, loadMenuOrderMinimums,
  cartSubtotal, placeAndPayNativeOrder, placeNativeInvoiceOrder,
  priceNativeCart, resolveCartMenuReference, type NativePlaceAndPayResult, type NativeInvoiceResult, type NativePlaceInput,
  type NativeDeliveryAddressInput,
} from './native-checkout'
import { checkItemInventoryAvailability } from './native-inventory'
import { checkCartMinimums } from './native-minimums'
import {
  reserveNativeRestaurantPromoUse, finalizeNativeRestaurantPromoUse, releaseNativeRestaurantPromoUse,
  type NativePromoResolution,
} from '../promo-native'

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

  // Items (and the menu they're tagged to) are resolved BEFORE the cap/date-time
  // gates below, not after, so those gates validate against the menu the order
  // actually claims — a direct API call could otherwise name a wide-open menu's
  // reference while its items are really from one with a tighter cutoff.
  const items = fmItemsToNativeCart(cd.items as Parameters<typeof fmItemsToNativeCart>[0])
  const menuReference = resolveCartMenuReference(items)

  // Daily order-capacity gate (max_orders_per_day) — checked right after the
  // date-level gates, before any pricing/promo/delivery work happens.
  if (await isNativeDailyCapReached(ref, orderDate, menuReference)) {
    return { ok: false, status: 409, error: 'This restaurant has reached its maximum number of orders for the selected date. Please choose a different date.' }
  }
  // Re-validate the requested date+time against the SAME scheduling rules the
  // checkout UI enforces (lead time, day-of-week window, Custom date-range
  // availability, skipped days) — the picker only hides invalid options, it
  // doesn't stop a direct API call from requesting one.
  const orderTime = String(cd.orderTime ?? '')
  if (!(await isNativeDateTimeValid(ref, orderDate, orderTime, menuReference))) {
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
  // Normalized once here rather than re-derived per gate — the order-minimum gate
  // below and the fulfillment-availability gate further down both need it.
  const requestedOrderType: 'DELIVERY' | 'PICKUP' = orderTypeRaw === 'DELIVERY' ? 'DELIVERY' : 'PICKUP'
  const tips = Number(cd.tips) || 0
  const tipsType = String(cd.tipsType ?? 'PERCENTAGE')

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

  // Item minimum quantity (min_quantity) + required modifier-group minimums
  // (min_selected) — the FIRST server-side gate either has ever had. The item
  // minimum previously had no gate at ANY layer: it imported correctly, was sent
  // to the browser, and was then read by nothing, so a customer could order 2 of a
  // min-4 Side and reach payment with a cart the kitchen doesn't make (orders
  // 900000099-101, 2026-08-27). The group minimum was enforced only by
  // RestaurantClient's isGroupValid — a button, not an enforcement. NOTE Direct
  // Entry is NOT the bypass: it routes to /order/{slug}?mode=direct-entry, which
  // renders the same RestaurantView -> RestaurantClient and therefore runs the same
  // client-side checks. The bypass is a direct POST to /api/order/place or
  // /api/restaurant/orders/place, which reaches placement without any UI at all.
  // Placed alongside the cap/date-time gates so both placement paths that route
  // through here — customer checkout and Direct Entry, card and invoice — are
  // covered.
  //
  // NOT covered: the recurring-orders cron, which builds its NativePlaceInput
  // itself and calls chargeAndPlaceNativeRecurringOrder directly. Adding the call
  // there would be inert anyway — its cart items carry no `reference` at all, only
  // names (see app/api/cron/recurring-orders/route.ts), so there is nothing to look
  // a minimum up by. Closing that properly means carrying item references into the
  // recurring snapshot; until then the cart editor's client-side floor (via
  // /api/order/item-minimums) is what keeps those carts valid.
  const minCheck = await checkCartMinimums(items)
  if (!minCheck.ok) {
    return { ok: false, status: 400, error: minCheck.message }
  }

  // Order-VALUE minimum (disco_menus.pickup_order_minimum / delivery_order_minimum)
  // — the third minimum, and the last one that was client-only. RestaurantClient's
  // `belowMin` disables the checkout button; that's a button, not an enforcement, so
  // a direct POST to /api/order/place or /api/restaurant/orders/place could place a
  // $10 order against a $200 minimum.
  //
  // SEMANTICS ARE COPIED FROM THE CLIENT DELIBERATELY (RestaurantClient.tsx:513-515
  // and :890), because a server gate that disagrees with the button is worse than
  // none — it would let a customer pass checkout and fail at placement:
  //   • RAW subtotal, NOT the discounted one. `belowMin` compares `subtotal`, not
  //     `discountedSubtotal`, so a promo can't drop a cart under the minimum. Same
  //     precedent as the promo's own minimum (lib/promo-native.ts, evaluated
  //     pre-discount).
  //   • ADD-ONS COUNT. cartSubtotal folds add-on prices into the unit price, as does
  //     the client's own cartSubtotal.
  //   • PER FULFILLMENT TYPE and PER MENU — resolved from the cart's tagged menu via
  //     menuReference, matching the client's `checkoutMenu`, not a restaurant-level
  //     setting.
  //   • 0 MEANS NO MINIMUM. See loadMenuOrderMinimums for why the client's nullish
  //     fallback chain is not reproduced.
  //
  // Checked before priceNativeCart because the raw subtotal needs no pricing pass,
  // so an under-minimum cart is refused before any promo/delivery/tax work happens.
  const orderMinimums = await loadMenuOrderMinimums(ref, menuReference)
  const minForType = requestedOrderType === 'DELIVERY' ? orderMinimums.delivery : orderMinimums.pickup
  if (minForType > 0) {
    const rawSubtotal = cartSubtotal(items)
    if (rawSubtotal < minForType) {
      const short = Math.round((minForType - rawSubtotal) * 100) / 100
      return {
        ok: false, status: 400,
        error: `This menu has a $${minForType.toFixed(2)} minimum for ${requestedOrderType === 'DELIVERY' ? 'delivery' : 'pickup'} orders — your subtotal is $${rawSubtotal.toFixed(2)}. Please add $${short.toFixed(2)} more.`,
      }
    }
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
  // No real tax rate on file — refuse rather than charge at a fabricated 0%
  // (loadNativePricingConfig's `?? 0` is the same defect class as the residual
  // tax formula: a missing value is indistinguishable from a real zero unless
  // something upstream refuses to use it).
  if (!priced.breakdown.taxReliable) {
    return { ok: false, status: 409, error: "This restaurant's tax rate isn't set up yet — orders can't be placed until it is. Contact support if this persists." }
  }
  // Server-side half of the per-menu fulfillment-availability toggle
  // (disco_menus.offers_pickup/offers_delivery) — the picker UI already
  // disables an unavailable option, but that's a client-side button, not an
  // enforcement. A restaurant can legitimately run one menu as pickup+delivery
  // and another (e.g. a holiday menu) as pickup-only; refuse here rather than
  // let a direct API call place the order type the menu doesn't offer.
  const avail = await loadMenuFulfillmentAvailability(ref, menuReference)
  if (requestedOrderType === 'DELIVERY' && !avail.offersDelivery) {
    return { ok: false, status: 400, error: 'This menu is pickup only — delivery isn\'t available for these items.' }
  }
  if (requestedOrderType === 'PICKUP' && !avail.offersPickup) {
    return { ok: false, status: 400, error: 'This menu is delivery only — pickup isn\'t available for these items.' }
  }
  const promo = priced.promo
  // A code was submitted but didn't resolve AT PLACEMENT specifically (not just
  // preview) — most likely a race against preview (a use-count cap exhausted, or
  // min_order_subtotal/first_time_only status changed) since the normal flow
  // clears the code client-side the moment preview reports promoError. Doesn't
  // block the order — same as before this fix, it just prices at full price —
  // but this is now visible server-side instead of a bare silent drop.
  if (params.restaurantPromoCode && !promo && priced.promoError) {
    console.error(`[native-place-checkout] restaurant-funded promo not applied at placement: restaurant=${ref} code=${params.restaurantPromoCode} reason=${priced.promoError}`)
  }

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
    scPct: await loadRestaurantServiceChargePct(ref, menuReference),
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

// Reserve the promo's cap slot BEFORE any charge is attempted — this is the
// gate itself, not bookkeeping. Concurrent orders for the same code/diner race
// here (see reserveNativeRestaurantPromoUse's own comment for why it's safe),
// and one of them gets refused before Stripe is ever involved.
async function reservePromoOrFail(promo: NativePromoResolution | null, params: NativeCheckoutParams, restaurantRef: string):
  Promise<{ ok: true; reservationId: number | null } | { ok: false; status: number; error: string }> {
  if (!promo) return { ok: true, reservationId: null }
  const r = await reserveNativeRestaurantPromoUse({
    promoId: promo.id, userEmail: params.customerEmail, maxUses: promo.maxUses, maxUsesPerUser: promo.maxUsesPerUser, restaurantRef,
  })
  if (!r.ok) {
    return {
      ok: false, status: 409,
      error: r.reason === 'max_uses'
        ? 'This promo code has reached its usage limit.'
        : 'You’ve already used this promo code the maximum number of times.',
    }
  }
  return { ok: true, reservationId: r.reservationId }
}

// Shared Disco-native order placement for BOTH the customer flow
// (/api/order/place) and Direct Entry (/api/restaurant/orders/place). Card path:
// places + creates the PaymentIntent for the browser to confirm; the webhook flips
// RESERVED→DUE on success. Returns a discriminated result.
export async function placeNativeCheckout(params: NativeCheckoutParams): Promise<NativeCheckoutOutcome> {
  const b = await buildNativePlaceInput(params)
  if (!b.ok) return b
  const { input, promo } = b.built

  const reserved = await reservePromoOrFail(promo, params, input.restaurantReference)
  if (!reserved.ok) return reserved

  let result: NativePlaceAndPayResult
  try {
    result = await placeAndPayNativeOrder(input, params.stripe, params.savedOpts)
  } catch (e) {
    if (reserved.reservationId != null && promo) await releaseNativeRestaurantPromoUse(reserved.reservationId, promo.id)
    throw e
  }

  if (reserved.reservationId != null) {
    await finalizeNativeRestaurantPromoUse(reserved.reservationId, {
      orderRef: result.orderReference, discountDollars: result.breakdown.discount, paymentIntentId: result.paymentIntentId,
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

  const reserved = await reservePromoOrFail(promo, params, input.restaurantReference)
  if (!reserved.ok) return reserved

  let result: NativeInvoiceResult
  try {
    result = await placeNativeInvoiceOrder(input, params.stripe)
  } catch (e) {
    if (reserved.reservationId != null && promo) await releaseNativeRestaurantPromoUse(reserved.reservationId, promo.id)
    throw e
  }

  if (reserved.reservationId != null) {
    await finalizeNativeRestaurantPromoUse(reserved.reservationId, {
      orderRef: result.orderReference, discountDollars: result.breakdown.discount, paymentIntentId: null,
    })
  }
  return { ok: true, result }
}
