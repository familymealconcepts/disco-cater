// Platform-wide order minimums — Disco's own rules, not a restaurant's.
//
// NO IMPORTS, DELIBERATELY. This module is imported by the customer storefront
// (a client component) AND by the server placement path, and it is the one
// definition both read. Pulling in the database or anything server-only here
// would make it unimportable from the browser and the two sides would drift —
// which is exactly the failure the server gate for the per-menu minimum already
// carries a long comment about.

/**
 * THE $100 THIRD-PARTY DELIVERY MINIMUM.
 *
 * Disco sets a $100 food-subtotal floor on every courier-delivered order, at
 * every restaurant. It is a PLATFORM rule: restaurants cannot see it, set it or
 * turn it off, and it is deliberately not a column on disco_menus next to
 * delivery_order_minimum (which IS theirs) so that it cannot be edited into
 * nothing from the portal.
 *
 * Change it HERE and nowhere else — both the storefront and the placement gate
 * read this constant, so one edit moves both and they cannot disagree.
 *
 * Subtotal means FOOD SUBTOTAL: before tax, fees, delivery fee and tip, and
 * before any promo discount (the same raw figure the per-menu minimum already
 * compares against, so a promo code can never drop a cart under the floor).
 */
export const PLATFORM_THIRD_PARTY_DELIVERY_MINIMUM = 100

/** A menu's delivery method as the storefront payload spells it. */
export function isThirdPartyDeliveryType(deliveryType: string | null | undefined): boolean {
  return String(deliveryType ?? '').toUpperCase() !== 'OWN_DELIVERY'
}

/**
 * The minimum that actually applies to a cart.
 *
 * THE HIGHER OF THE TWO WINS. A restaurant that has set its own delivery
 * minimum above $100 keeps it; one below $100 (including 0, which means "no
 * minimum of mine") is raised to the platform floor. Pickup and the
 * restaurant's OWN delivery are untouched — they keep exactly the restaurant's
 * own number, platform floor included nowhere.
 */
export function effectiveOrderMinimum(args: {
  orderType: 'PICKUP' | 'DELIVERY'
  /** Only meaningful when orderType is DELIVERY. */
  isThirdPartyDelivery: boolean
  /** The restaurant's own minimum for this fulfillment type; 0 means none. */
  restaurantMinimum: number | null | undefined
}): number {
  const own = Math.max(0, Number(args.restaurantMinimum) || 0)
  if (args.orderType !== 'DELIVERY' || !args.isThirdPartyDelivery) return own
  return Math.max(PLATFORM_THIRD_PARTY_DELIVERY_MINIMUM, own)
}

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`

/**
 * What the customer is told, used by BOTH the storefront and the server refusal
 * so the two can never word it differently.
 *
 * NEVER SAYS "THIRD-PARTY DELIVERY". That is Disco's internal distinction
 * between a courier and a restaurant's own driver, and it means nothing to a
 * diner — to them there is only "delivery". The phrase does not appear in any
 * customer-facing string in this file on purpose.
 */
export function orderMinimumMessage(args: {
  minimum: number
  subtotal: number
  orderType: 'PICKUP' | 'DELIVERY'
  /** Adds the "or switch to pickup" half only when pickup is actually offered. */
  offersPickup: boolean
}): string {
  const short = Math.max(0, Math.round((args.minimum - args.subtotal) * 100) / 100)
  const noun = args.orderType === 'DELIVERY' ? 'Delivery' : 'Pickup'
  const tail = args.orderType === 'DELIVERY' && args.offersPickup ? ', or switch to pickup' : ''
  return `${noun} orders have a ${money(args.minimum)} minimum. Add ${money(short)} more to check out${tail}.`
}
