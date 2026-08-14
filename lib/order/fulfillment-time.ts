// Self-delivery fulfillment/pickup time = order time minus 30 minutes, per FM's
// EmailNotificationServiceImpl.createProperties() (OWN_DELIVERY offset — this is
// the exact rule FM applies, confirmed by reading FM's own Java source). Pickup
// has no offset (order time IS the pickup time — the customer is their own
// driver). Third-party delivery's real readiness moment is the courier's own
// ETA (Expedite/DoorDash/etc, disco_orders.order_drop_off_time once dispatched)
// — never a fixed offset; falls back to the raw order time when no courier
// drop-off time is known yet (e.g. before dispatch).
//
// Pure wall-clock arithmetic on the naked order_date ('YYYY-MM-DD') / order_time
// ('HH:MM' or 'HH:MM:SS') strings — never a timezone conversion, since these are
// already stored as the restaurant's local wall-clock values (see
// nowWallClockInTz's comment in the orders portal page for the same convention).
// Handles day rollover (e.g. 12:10 AM -> 11:40 PM the prior day).
export function selfDeliveryFulfillmentDateTime(
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
): { date: string; time: string } | null {
  if (!orderDate || !orderTime) return null
  const [y, mo, d] = orderDate.split('-').map(Number)
  const [h, mi, s] = orderTime.split(':').map(Number)
  if (!y || !mo || !d || !Number.isFinite(h) || !Number.isFinite(mi)) return null
  const dt = new Date(y, mo - 1, d, h, mi, Number.isFinite(s) ? s : 0)
  dt.setMinutes(dt.getMinutes() - 30)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`,
  }
}

// The date/time to display in the "Ready By" block for a given delivery type.
// OWN_DELIVERY gets the minus-30 offset. Any other delivery type (third-party —
// NASH_DELIVERY/DLIVRD_DELIVERY/THIRD_PARTY_DELIVERY/etc) uses the courier's own
// drop-off time when one has been recorded, since that's the real readiness
// moment, not a fixed assumption. Pickup, and third-party before a courier
// drop-off time exists, show the raw order date/time unchanged.
export function fulfillmentDateTime(
  deliveryType: string | null | undefined,
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
  courierDropOffTime?: string | null,
): { date: string; time: string } | null {
  if (deliveryType === 'OWN_DELIVERY') {
    const adjusted = selfDeliveryFulfillmentDateTime(orderDate, orderTime)
    if (adjusted) return adjusted
  } else if (deliveryType && courierDropOffTime && orderDate) {
    // order_drop_off_time is a bare TIME (no date of its own) — pairs with the
    // order's own date, same convention as the rest of this module.
    return { date: orderDate, time: courierDropOffTime }
  }
  if (!orderDate || !orderTime) return null
  return { date: orderDate, time: orderTime }
}
