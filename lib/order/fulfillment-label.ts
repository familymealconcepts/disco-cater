/**
 * The ONE definition of how an order's fulfillment method is labelled.
 *
 * Exactly three values reach a screen — PICKUP, SELF-DELIVERY, THIRD-PARTY
 * DELIVERY — because that is the set a restaurant actually acts on. Which
 * courier network a third-party order rides (Dlivrd, Nash, DoorDash) is our
 * plumbing, not their decision, so it is deliberately not surfaced.
 *
 * WHY THIS IS A SHARED MODULE. It replaces two byte-identical DELIVERY_LABEL
 * maps (the portal orders list and the restaurant-customers order history) that
 * carried the same defect, which is the failure mode a duplicated decision
 * always has: the map was missing a key, and BOTH copies were missing it.
 *
 * THE DEFECT IT FIXES, precisely. The old map keyed only OWN_DELIVERY,
 * NASH_DELIVERY, DOOR_DASH_DELIVERY and DLIVRD_DELIVERY, then fell back to
 * `order.orderType`:
 *
 *     DELIVERY_LABEL[order.deliveryType] || order.orderType || '—'
 *
 * THIRD_PARTY_DELIVERY was not a key. So the newest and most operationally
 * important delivery type — the one Disco itself dispatches a courier for — fell
 * through to order_type and rendered as a bare "DELIVERY", while its DLIVRD and
 * NASH siblings on the same screen rendered "Third-Party Delivery". Order
 * 900000093 is the worked example. The fallback was not a safety net; it was
 * what hid the missing key, by producing a plausible-looking word instead of
 * nothing.
 *
 * Measured against production (24,326 live orders):
 *     THIRD_PARTY_DELIVERY      3   rendered "DELIVERY"           <- wrong
 *     DOOR_DASH_DELIVERY       28   rendered "DoorDash Delivery"  <- 4th value
 *     DLIVRD_DELIVERY       1,549   rendered "Third-Party Delivery"
 *     NASH_DELIVERY           392   rendered "Third-Party Delivery"
 *     OWN_DELIVERY          2,696   rendered "Self-Delivery"
 *     PICKUP                   24   rendered "PICKUP"
 *     (null)               19,634   rendered "PICKUP"
 *
 * THE NULL delivery_type ROWS NEED NO GUESS, which is worth stating because it
 * looks like they would. All 19,634 of them carry order_type = 'PICKUP' — there
 * is not one null-delivery_type row with order_type = 'DELIVERY' in production
 * (verified directly, including against disco_sale_transactions' own/third-party
 * fee columns, which have zero such rows to discriminate). So the order_type
 * fallback resolves every historical FM-mirrored row correctly and none of them
 * can render blank or as a fourth value.
 *
 * `deliveryType` is the discriminator and `orderType` is only ever a fallback,
 * never a source of a delivery label — reading order_type for a delivery is what
 * produced the bare "DELIVERY" in the first place.
 */

export type FulfillmentLabel = 'PICKUP' | 'SELF-DELIVERY' | 'THIRD-PARTY DELIVERY'

// Every third-party courier value seen in production, plus the provider names
// most likely to arrive next (Shipday is already mirrored in
// disco_restaurant_overrides; Uber is the obvious next network). Matching on a
// pattern rather than an exhaustive key list is the point: a provider nobody has
// added yet lands on the correct GENERIC label instead of falling through to
// order_type and rendering "DELIVERY", which is exactly how this broke.
const THIRD_PARTY_RE = /THIRD_PARTY|THIRDPARTY|DLIVRD|NASH|DOOR_?DASH|SHIPDAY|UBER|EXPEDITE|GRUBHUB|POSTMATES/

/**
 * Label an order's fulfillment method. Total over its inputs: every
 * combination, including both-null, returns one of the three values.
 */
export function fulfillmentLabel(
  deliveryType: string | null | undefined,
  orderType?: string | null | undefined,
): FulfillmentLabel {
  const dt = String(deliveryType ?? '').trim().toUpperCase()
  const ot = String(orderType ?? '').trim().toUpperCase()

  if (dt === 'PICKUP') return 'PICKUP'
  if (dt === 'OWN_DELIVERY' || dt === 'SELF_DELIVERY') return 'SELF-DELIVERY'
  if (dt && THIRD_PARTY_RE.test(dt)) return 'THIRD-PARTY DELIVERY'

  // No usable delivery_type: fall back to order_type. This is the path all
  // 19,634 historical rows take, and every one of them is a PICKUP.
  if (ot === 'PICKUP') return 'PICKUP'

  // A delivery with no recorded delivery_type. UNREACHABLE in production today
  // (zero such rows) — this exists so a future row cannot render blank. Defaults
  // to SELF-DELIVERY rather than third-party because a third-party order only
  // exists once a courier network was chosen, and choosing one is precisely what
  // writes delivery_type; a delivery with no network recorded is one the
  // restaurant ran itself. If this branch ever starts matching real rows, that
  // is a signal delivery_type stopped being written, not that the default is
  // wrong.
  return 'SELF-DELIVERY'
}
