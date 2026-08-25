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

// TITLE CASE, not caps. These strings land in an email subject ("Your
// Third-Party Delivery Order will be ready on:"), in PDF body copy, in an SMS
// sentence, and in table cells — so caps would shout in most of the places they
// appear. The PDF's own pre-existing fallback was already 'Pickup', so title
// case is the house style here rather than a new convention.
export type FulfillmentLabel = 'Pickup' | 'Self-Delivery' | 'Third-Party Delivery'

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

  if (dt === 'PICKUP') return 'Pickup'
  if (dt === 'OWN_DELIVERY' || dt === 'SELF_DELIVERY') return 'Self-Delivery'
  if (dt && THIRD_PARTY_RE.test(dt)) return 'Third-Party Delivery'

  // No usable delivery_type: fall back to order_type. This is the path all
  // 19,634 historical rows take, and every one of them is a PICKUP.
  if (ot === 'PICKUP') return 'Pickup'

  // A delivery with no recorded delivery_type. UNREACHABLE in production today
  // (zero such rows) — this exists so a future row cannot render blank. Defaults
  // to SELF-DELIVERY rather than third-party because a third-party order only
  // exists once a courier network was chosen, and choosing one is precisely what
  // writes delivery_type; a delivery with no network recorded is one the
  // restaurant ran itself. If this branch ever starts matching real rows, that
  // is a signal delivery_type stopped being written, not that the default is
  // wrong.
  return 'Self-Delivery'
}

/**
 * Is this order fulfilled by a third-party courier network?
 *
 * A PREDICATE, NOT A LABEL, and the distinction is the point. Restaurant email
 * templates branch on this to decide whether to render courier-specific copy,
 * and they previously hand-maintained their own list:
 *
 *     const isThirdPartyDelivery =
 *       p.deliveryType === 'NASH_DELIVERY' || p.deliveryType === 'DLIVRD_DELIVERY'
 *       || p.deliveryType === 'THIRD_PARTY'
 *
 * which omits BOTH real values it most needed — 'THIRD_PARTY_DELIVERY' (the
 * value Disco's own native dispatch writes, and the only one where we booked the
 * courier) and 'DOOR_DASH_DELIVERY' — while including 'THIRD_PARTY', which no
 * row has ever held. Exactly the defect the Service column had, in a second
 * file, found while fixing the first.
 */
export function isThirdPartyFulfillment(deliveryType: string | null | undefined): boolean {
  const dt = String(deliveryType ?? '').trim().toUpperCase()
  return !!dt && THIRD_PARTY_RE.test(dt)
}

/**
 * Is food going TO the customer (any delivery flavour) rather than being
 * collected?
 *
 * MUST NOT be derived from the display label, which is why it exists. The
 * restaurant email computed it as
 * `String(p.orderService).toUpperCase() === 'DELIVERY' || isThirdPartyDelivery`,
 * where orderService was the raw order_type enum. Feeding a human label into
 * that comparison silently breaks it: 'Self-Delivery'.toUpperCase() is not
 * 'DELIVERY', so every self-delivery order would have stopped rendering its
 * delivery address. Read the data fields, never the string shown to a person.
 */
export function isDeliveryFulfillment(
  deliveryType: string | null | undefined,
  orderType?: string | null | undefined,
): boolean {
  return fulfillmentLabel(deliveryType, orderType) !== 'Pickup'
}

/**
 * What the restaurant portal's "Delivery Status" column should show.
 *
 * Two populations, and they are NOT the same "no status" — showing one dash for
 * both is what made this column look broken rather than empty:
 *
 *   NATIVE (delivery_type = THIRD_PARTY_DELIVERY, 3 orders) — Disco dispatched
 *     the courier through Expedite, so a status is ours to know. Real status if
 *     we have one; otherwise it says the dispatch happened but no update has
 *     come back, which is true and actionable.
 *
 *   FM-BOOKED (DLIVRD / NASH / DOOR_DASH, 1,969 orders) — FamilyMeal booked the
 *     courier. Disco has no relationship with that delivery, never dispatched
 *     it, and will never receive a status for it. "Booked by FamilyMeal" says
 *     that plainly instead of implying we are waiting on something.
 *
 * Self-delivery and pickup get a dash because no courier exists — there is
 * genuinely nothing to report, which is different again from both cases above.
 */
export function deliveryStatusLabel(
  deliveryType: string | null | undefined,
  expediteStatus: string | null | undefined,
  expediteDeliveryId: string | null | undefined,
): string {
  const dt = String(deliveryType ?? '').trim().toUpperCase()
  if (!isThirdPartyFulfillment(dt)) return '—'

  // Native dispatch is the only third-party value Disco itself books.
  const isNativeDispatch = dt === 'THIRD_PARTY_DELIVERY' || dt === 'THIRDPARTY_DELIVERY'
  if (!isNativeDispatch) return 'Booked by FamilyMeal'

  const status = String(expediteStatus ?? '').trim()
  if (status) return status
  const id = String(expediteDeliveryId ?? '').trim()
  // 'PENDING' is dispatchExpediteForOrder's in-flight claim, not a courier state.
  if (id === 'PENDING') return 'Dispatching…'
  if (id) return 'Awaiting courier update'
  return '—'
}
