import type Stripe from 'stripe'
import {
  fmItemsToNativeCart, cartSubtotal, isNativeOrderingOpen, isNativeDateClosed,
  loadRestaurantServiceChargePct, placeAndPayNativeOrder,
  type NativePlaceAndPayResult, type NativePlaceInput,
} from './native-checkout'
import { validateNativeDelivery } from './native-delivery'
import type { Fulfillment } from '../pricing/native-order'

export type NativeCheckoutOutcome =
  | { ok: true; result: NativePlaceAndPayResult }
  | { ok: false; status: number; error: string }

// Shared Disco-native order placement for BOTH the customer flow
// (/api/order/place) and Direct Entry (/api/restaurant/orders/place). The only
// per-caller difference is how the customer identity + saved card are resolved;
// everything from the ordering-open / closed-date gates through the priced,
// PaymentIntent-backed placement lives here so the two money paths can never drift.
// Returns a discriminated result: the caller maps { ok:false } to its own response.
export async function placeNativeCheckout(params: {
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
  companyName?: string | null
  headcount?: number | null
  stripe: Stripe
  savedOpts?: { customerId?: string }
}): Promise<NativeCheckoutOutcome> {
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

  const orderTypeRaw = String(cd.orderType ?? (params.deliveryAddress ? 'DELIVERY' : 'PICKUP'))
  const tips = Number(cd.tips) || 0
  const tipsType = String(cd.tipsType ?? 'PERCENTAGE')
  const items = fmItemsToNativeCart(cd.items as Parameters<typeof fmItemsToNativeCart>[0])

  // Fulfillment + delivery fee resolved authoritatively from the menu's delivery
  // settings + the real distance/subtotal — the client never dictates them.
  let fulfillment: Fulfillment = 'PICKUP'
  let deliveryFee = 0
  let thirdPartyDeliverySubsiding = 0
  if (orderTypeRaw === 'DELIVERY') {
    const dv = await validateNativeDelivery(ref, (params.deliveryAddress || {}) as Parameters<typeof validateNativeDelivery>[1], cartSubtotal(items))
    if (!dv.valid) return { ok: false, status: 400, error: dv.message || 'That delivery address is not serviceable.' }
    fulfillment = dv.fulfillment
    deliveryFee = dv.deliveryFee
    thirdPartyDeliverySubsiding = dv.thirdPartyDeliverySubsiding
  }

  const result = await placeAndPayNativeOrder({
    restaurantReference: ref,
    customerEmail: params.customerEmail,
    customerFirstName: params.customerFirstName ?? undefined,
    customerLastName: params.customerLastName ?? undefined,
    customerPhone: params.customerPhone ?? undefined,
    fulfillment,
    items,
    tip: tipsType === 'CUSTOM' ? { custom: true, amount: tips } : { custom: false, pct: tips },
    deliveryFee,
    thirdPartyDeliverySubsiding,
    scPct: await loadRestaurantServiceChargePct(ref),
    orderDate,
    orderTime: String(cd.orderTime ?? ''),
    deliveryAddress: params.deliveryAddress as NativePlaceInput['deliveryAddress'],
    note: params.note ?? null,
    companyName: params.companyName ?? null,
    persons: params.headcount ?? null,
  }, params.stripe, params.savedOpts)

  return { ok: true, result }
}
