// THE SINGLE AUTHORITY FOR "WHEN MUST THE FOOD BE READY."
//
// One value, two consumers with very different stakes: the "Ready By" block a
// restaurant reads (display), and the pickup time sent to the courier
// (operational — it books a real driver). They disagreed in production because
// each derived its own answer: order 900000093 showed Ready By 12:45 PM (the
// raw requested time) while Expedite was told to collect at 12:45 and deliver
// at 1:15 — 30 minutes late at both ends. Both now come from here.
//
// THE RULES, by delivery type:
//   PICKUP (or no delivery at all) — ready-by IS the requested time. The
//     customer is their own driver; nothing has to happen earlier.
//   OWN_DELIVERY — requested time minus 30. This is FM's own rule, confirmed by
//     reading FM's Java source (EmailNotificationServiceImpl.createProperties,
//     and independently ShipdayPayloadBuilder.resolvePickupLocalTime, which
//     documents "OWN_DELIVERY: pickup is 30 minutes before order time").
//   THIRD-PARTY (Expedite/dlivrd/Nash/DoorDash) — requested time minus 30, as a
//     DEFAULT standing in for a real courier pickup time we do not yet receive.
//
// WHY THIRD-PARTY IS A FIXED DEFAULT RATHER THAN THE COURIER'S OWN TIME.
// This module used to prefer disco_orders.order_drop_off_time for third-party,
// describing it as "the courier's own ETA." That was wrong twice over and has
// been retired:
//   1. It never fired. order_drop_off_time is NULL on all 24,318 orders in
//      production — every delivery type, including all 1,548 DLIVRD, 392 NASH,
//      28 DOOR_DASH and 3 THIRD_PARTY rows. It was dead code.
//   2. It is not an ETA. FM populates that column as orderTime.minusMinutes(N)
//      (RestaurantOrderServiceImpl) — a computed PICKUP time. And even a real
//      drop-off time would be the wrong thing to show: food must be ready
//      BEFORE the courier arrives to collect it, not when it reaches the
//      customer.
// Nothing here writes that column, and nothing reads it any more. When a real
// courier pickup time is captured from Expedite's response, it belongs in this
// function as a preferred input ahead of the default — not at a call site.
//
// Pure wall-clock arithmetic on the naked order_date ('YYYY-MM-DD') /
// order_time ('HH:MM' or 'HH:MM:SS') strings — never a timezone conversion,
// since these are already stored as the restaurant's local wall-clock values.
// Callers that need an instant (the Expedite payload) convert afterwards with
// their own zone-aware helper. Handles day rollover (12:10 AM -> 11:40 PM the
// prior day).

// The lead time a kitchen gets ahead of the requested moment, for any
// fulfillment type where someone other than the customer collects the food.
export const READY_BY_LEAD_MINUTES = 30

// Third-party couriers, by disco_orders.delivery_type. All four values exist in
// production (DLIVRD_DELIVERY 1548, NASH_DELIVERY 392, DOOR_DASH_DELIVERY 28,
// THIRD_PARTY_DELIVERY 3), so matching only the literal THIRD_PARTY_DELIVERY
// would miss 1,968 of the 1,971 third-party orders.
//
// A NULL delivery_type is deliberately NOT third-party. 19,630 historical
// FM-mirrored rows carry null, and treating those as third-party would shift
// every one of them by 30 minutes.
const THIRD_PARTY_DELIVERY_TYPES = new Set([
  'THIRD_PARTY_DELIVERY',
  'DLIVRD_DELIVERY',
  'NASH_DELIVERY',
  'DOOR_DASH_DELIVERY',
])

export function isThirdPartyDeliveryType(deliveryType: string | null | undefined): boolean {
  if (!deliveryType) return false
  return THIRD_PARTY_DELIVERY_TYPES.has(String(deliveryType).trim().toUpperCase())
}

// Shift a wall-clock date/time by a signed number of minutes, returning the
// same naked-string shape. Local Date construction is safe here precisely
// because both input and output are wall-clock in the same (unstated) zone —
// no instant is ever formed, so the machine's own timezone cannot leak in.
function shiftWallClock(
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
  deltaMinutes: number,
): { date: string; time: string } | null {
  if (!orderDate || !orderTime) return null
  const [y, mo, d] = String(orderDate).split('-').map(Number)
  const [h, mi, s] = String(orderTime).split(':').map(Number)
  if (!y || !mo || !d || !Number.isFinite(h) || !Number.isFinite(mi)) return null
  const dt = new Date(y, mo - 1, d, h, mi, Number.isFinite(s) ? s : 0)
  dt.setMinutes(dt.getMinutes() + deltaMinutes)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`,
  }
}

// Kept for the OWN_DELIVERY case specifically, since that rule is FM's and is
// worth naming. Third-party uses the same arithmetic but for a different
// reason (a stand-in default, not a mirrored business rule), so the two are
// not collapsed into one named export.
export function selfDeliveryFulfillmentDateTime(
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
): { date: string; time: string } | null {
  return shiftWallClock(orderDate, orderTime, -READY_BY_LEAD_MINUTES)
}

/**
 * When the food must be ready, for a given delivery type.
 *
 * Returns naked wall-clock strings in the restaurant's own local time — the
 * same shape as the stored order_date/order_time. Returns null only when the
 * inputs are unusable, so callers should fall back to the raw order values.
 */
export function fulfillmentDateTime(
  deliveryType: string | null | undefined,
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
): { date: string; time: string } | null {
  if (deliveryType === 'OWN_DELIVERY' || isThirdPartyDeliveryType(deliveryType)) {
    const adjusted = shiftWallClock(orderDate, orderTime, -READY_BY_LEAD_MINUTES)
    if (adjusted) return adjusted
  }
  // PICKUP, null, and anything unrecognised: the requested time, unchanged.
  if (!orderDate || !orderTime) return null
  return { date: orderDate, time: orderTime }
}
