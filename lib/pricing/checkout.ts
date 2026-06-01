// Checkout payload builder — mirrors FM's ICheckoutPreview DTO, which FM
// POSTs to /orders/init and PUTs to /orders/{ref} (the SAME body; see
// meal-package.service.ts:311-355 checkoutPricesV2).
//
// CRITICAL shape facts (these caused the init 500 when wrong):
//   - The cart goes in `items` (IMealPackageSimpleResponse[]), NOT
//     `mealPackages`. FM populates `items` and sends `mealPackages: []`
//     (checkout-sidebar-preview.component.ts:270,593).
//   - `orderDate` is DD.MM.YYYY (DateFormatService.formatDate,
//     component.ts:601) — NOT ISO. ISO 500s the server.
//   - Each item needs `restaurant: { reference }` (component.ts:574).
//   - Top-level `restaurantReference` (component.ts:574).
//   - extraItems on each item: { reference, name, price, count,
//     type: 'ADD_ON', extraItemsGroupReference } (component.ts:585-587).
//   - Unknown order-level fields (note / comment / orderHeadcount) are NOT
//     in the DTO and are dropped — FM has no headcount field.

import type { CartLine, CartAddOn } from './cart'

export interface CheckoutCartLine extends CartLine {
  /** Meal-package UUID. */
  reference: string
  /** Display name (FM item.name) — optional; server resolves by reference. */
  name?: string
  /** Optional special-instructions string → item.comment. */
  note?: string
}

// ISO (YYYY-MM-DD) → FM's DD.MM.YYYY. Pass through anything already non-ISO.
function toFmDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '')
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d
}

export interface CheckoutPayloadOptions {
  restaurantRef: string
  cart: CheckoutCartLine[]
  orderType: 'DELIVERY' | 'PICKUP'
  orderDate: string
  orderTime: string
  deliveryAddress?: {
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    zipcode: string
    latitude?: number
    longitude?: number
    deliveryInstructions?: string
  }
  /** Diner headcount; FM has no dedicated field so we stash it in the
   *  note (and also send `orderHeadcount` in case FM ever adds support). */
  headcount?: number | null
}

interface CheckoutItem {
  reference: string
  restaurant: { reference: string }
  count: number
  itemType: 'MEAL_PACKAGES'
  name?: string
  price?: number
  comment?: string
  extraItems: CheckoutAddOn[]
}

interface CheckoutAddOn {
  reference?: string
  name?: string
  price: number
  count: number
  type: 'ADD_ON'
  extraItemsGroupReference?: string
}

export interface CheckoutPayload {
  /** Consumed by the /api/order/init|update proxy to build the URL; stripped
   *  before forwarding to FM. */
  restaurantRef: string
  /** FM body field (component.ts:574). */
  restaurantReference: string
  items: CheckoutItem[]
  mealPackages: []
  orderType: 'DELIVERY' | 'PICKUP'
  orderDate: string
  orderTime: string
  tips: number
  tipsType: string
  taxExempt: boolean
  deliveryAddress?: CheckoutPayloadOptions['deliveryAddress']
}

function mapAddOn(a: CartAddOn): CheckoutAddOn {
  return {
    reference: a.reference,
    name: a.name,
    price: a.price,
    count: a.count,
    type: 'ADD_ON',
    extraItemsGroupReference: a.extraItemsGroupReference,
  }
}

function mapItem(line: CheckoutCartLine, restaurantRef: string): CheckoutItem {
  const qty = line.count ?? line.quantity ?? 1
  return {
    reference: line.reference,
    restaurant: { reference: restaurantRef },
    count: qty,
    itemType: 'MEAL_PACKAGES',
    ...(line.name ? { name: line.name } : {}),
    ...(typeof line.price === 'number' ? { price: line.price } : {}),
    ...(line.note ? { comment: line.note } : {}),
    extraItems: (line.addOns ?? []).map(mapAddOn),
  }
}

export function buildCheckoutPayload(opts: CheckoutPayloadOptions): CheckoutPayload {
  const { restaurantRef, cart, orderType, orderDate, orderTime, deliveryAddress } = opts

  const payload: CheckoutPayload = {
    restaurantRef,
    restaurantReference: restaurantRef,
    items: cart.map(line => mapItem(line, restaurantRef)),
    mealPackages: [],
    orderType,
    orderDate: toFmDate(orderDate),
    orderTime,
    tips: 0,
    tipsType: 'PERCENTAGE',
    taxExempt: false,
  }
  if (orderType === 'DELIVERY' && deliveryAddress) payload.deliveryAddress = deliveryAddress
  return payload
}

// ─── Inline test cases ───────────────────────────────────────────────
//
// Case 1 — Pudding × 1 with TestModifier, pickup on 2026-05-30
//   opts = { restaurantRef: 'rest-ref', orderType: 'PICKUP',
//            orderDate: '2026-05-30', orderTime: '09:00:00',
//            cart: [{ reference: 'pud-ref', price: 100, count: 1, addOns: [
//              { reference: 'mod-ref', name: 'TestModifier', price: 91,
//                count: 1, extraItemsGroupReference: 'grp-ref' } ] }] }
//   payload:
//     { restaurantReference: 'rest-ref', mealPackages: [],
//       orderDate: '30.05.2026', orderTime: '09:00:00', orderType: 'PICKUP',
//       tips: 0, tipsType: 'PERCENTAGE', taxExempt: false,
//       items: [{ reference: 'pud-ref', restaurant: { reference: 'rest-ref' },
//                 count: 1, itemType: 'MEAL_PACKAGES', price: 100,
//                 extraItems: [{ reference: 'mod-ref', name: 'TestModifier',
//                   price: 91, count: 1, type: 'ADD_ON',
//                   extraItemsGroupReference: 'grp-ref' }] }] }
//   FM server computes line total = (100 + 91*1) * 1 = $191 ✓
//
// Case 2 — Pudding × 2 with same modifier (scaling-confirmation case)
//   cart = [{ ..., count: 2, addOns: [{ ..., count: 1 }] }]
//   payload.items[0].count = 2, items[0].extraItems[0].count = 1
//   FM server computes line total = (100 + 91*1) * 2 = $382 ✓
//
// Case 3 — Delivery order
//   opts.orderType = 'DELIVERY', opts.deliveryAddress = { ... }
//   payload.orderType = 'DELIVERY', payload.deliveryAddress = { ... }
//   (headcount is NOT sent — FM's DTO has no field for it.)
