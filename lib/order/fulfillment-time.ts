// Self-delivery fulfillment/pickup time = order time minus 30 minutes, per FM's
// EmailNotificationServiceImpl.createProperties() (OWN_DELIVERY offset — this is
// the exact rule FM applies, confirmed by reading FM's own Java source). Pickup
// has no offset (order time IS the pickup time). Third-party delivery's real
// fulfillment time is meant to come from the courier (Expedite), never computed
// locally — Disco has no stored field for that yet, so third-party orders are
// left untouched here.
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

// The date/time to display in a "pick-up time" block for a given delivery type.
// OWN_DELIVERY gets the minus-30 offset; every other type (pickup, third-party)
// shows the raw order date/time unchanged.
export function fulfillmentDateTime(
  deliveryType: string | null | undefined,
  orderDate: string | null | undefined,
  orderTime: string | null | undefined,
): { date: string; time: string } | null {
  if (deliveryType === 'OWN_DELIVERY') {
    const adjusted = selfDeliveryFulfillmentDateTime(orderDate, orderTime)
    if (adjusted) return adjusted
  }
  if (!orderDate || !orderTime) return null
  return { date: orderDate, time: orderTime }
}
