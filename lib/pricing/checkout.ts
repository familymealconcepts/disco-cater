// Checkout payload builder. Mirrors FM's order-init POST body shape
// exactly — confirmed against
// _system/_models/checkout-preview.model.ts:6-33 and
// pages/public/checkout/checkout-sidebar-preview/checkout-sidebar-preview.component.ts:829-837.
//
// Field-name reminders from the audit (§ 1.3 of
// docs/fm-cart-checkout-reconciliation.md):
//   - FM expects `extraItems` on POST (read responses use `orderAddOns`).
//   - Each modifier needs `type: 'ADD_ON'` + `extraItemsGroupReference`.
//   - Meal-package qty is `count` on FM. We continue sending `quantity`
//     alongside it for any legacy shim path — FM ignores unknown fields
//     and it costs nothing.
//   - `itemType: 'MEAL_PACKAGES'` on each meal line is required.
//
// Cart-line semantics confirmed by live test order (Pudding × 1 → $191,
// Pudding × 2 → $382): `addon.count` is the per-meal modifier qty; FM
// scales it by `meal.count` server-side. So we pass through unchanged.

import type { CartLine, CartAddOn } from './cart'

export interface CheckoutCartLine extends CartLine {
  /** Meal-package UUID. */
  reference: string
  /** Optional special-instructions string. */
  note?: string
}

export interface CheckoutPayloadOptions {
  restaurantRef: string
  cart: CheckoutCartLine[]
  orderType: 'DELIVERY' | 'PICKUP'
  orderDate: string
  orderTime: string
  deliveryAddress?: {
    addressLine1: string
    city: string
    state: string
    zipcode: string
    latitude?: number
    longitude?: number
  }
  /** Diner headcount; FM has no dedicated field so we stash it in the
   *  note (and also send `orderHeadcount` in case FM ever adds support). */
  headcount?: number | null
}

interface CheckoutMealPackage {
  reference: string
  quantity: number
  count: number
  itemType: 'MEAL_PACKAGES'
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
  restaurantRef: string
  mealPackages: CheckoutMealPackage[]
  orderType: 'DELIVERY' | 'PICKUP'
  orderDate: string
  orderTime: string
  deliveryAddress?: CheckoutPayloadOptions['deliveryAddress']
  orderHeadcount?: number
  note?: string
  comment?: string
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

function mapLine(line: CheckoutCartLine): CheckoutMealPackage {
  const qty = line.count ?? line.quantity ?? 1
  return {
    reference: line.reference,
    quantity: qty,
    count: qty,
    itemType: 'MEAL_PACKAGES',
    ...(line.note ? { comment: line.note } : {}),
    extraItems: (line.addOns ?? []).map(mapAddOn),
  }
}

export function buildCheckoutPayload(opts: CheckoutPayloadOptions): CheckoutPayload {
  const { restaurantRef, cart, orderType, orderDate, orderTime, deliveryAddress, headcount } = opts

  const note = headcount != null ? `Headcount: ${headcount}` : ''

  const payload: CheckoutPayload = {
    restaurantRef,
    mealPackages: cart.map(mapLine),
    orderType,
    orderDate,
    orderTime,
  }
  if (orderType === 'DELIVERY' && deliveryAddress) payload.deliveryAddress = deliveryAddress
  if (headcount != null) payload.orderHeadcount = headcount
  if (note) { payload.note = note; payload.comment = note }
  return payload
}

// ─── Inline test cases ───────────────────────────────────────────────
//
// Case 1 — Pudding × 1 with TestModifier, pickup
//   cart = [{ reference: 'pud-ref', price: 100, count: 1, addOns: [
//     { reference: 'mod-ref', name: 'TestModifier', price: 91, count: 1,
//       extraItemsGroupReference: 'grp-ref' } ] }]
//   payload.mealPackages[0]:
//     { reference: 'pud-ref', quantity: 1, count: 1,
//       itemType: 'MEAL_PACKAGES',
//       extraItems: [{ reference: 'mod-ref', name: 'TestModifier',
//                      price: 91, count: 1, type: 'ADD_ON',
//                      extraItemsGroupReference: 'grp-ref' }] }
//   FM server computes line total = (100 + 91*1) * 1 = $191 ✓
//
// Case 2 — Pudding × 2 with same modifier (the scaling-confirmation case)
//   cart = [{ ..., count: 2, addOns: [{ ..., count: 1 }] }]
//   payload.mealPackages[0].count = 2, extraItems[0].count = 1
//   FM server computes line total = (100 + 91*1) * 2 = $382 ✓
//
// Case 3 — Delivery order with headcount
//   opts.headcount = 30, opts.orderType = 'DELIVERY'
//   payload.orderHeadcount = 30
//   payload.note = 'Headcount: 30'
//   payload.deliveryAddress = { ... }
