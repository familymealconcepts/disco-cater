// Delivery Order Time Windows — mirrors FM's `timeRangeFormat` pipe
// (familymeal-platform time-range-format-pipe.ts).
//
// FM's restaurant-level `deliveryOrderTimeWindows` setting (valid values:
// 'exact' | '30_min' | '1_hour') controls how the order time is DISPLAYED for
// DELIVERY orders: a range "start - (start + window)" instead of an exact time.
// PICKUP orders, an 'exact'/absent window, or unparseable input always show the
// exact start time. The stored order time is always the START time — the range
// is display-only.

const WINDOW_MINUTES: Record<string, number> = { '30_min': 30, '1_hour': 60 }

function to12h(h: number, m: number): string {
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

// startTime: "HH:mm" (24h). windowKey: 'exact' | '30_min' | '1_hour' | null.
// isDelivery: only DELIVERY orders get the range (FM's `deliveryType` guard).
export function formatTimeWindow(
  startTime: string,
  windowKey?: string | null,
  isDelivery?: boolean,
): string {
  const [h, m] = String(startTime || '').split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return String(startTime || '')
  const start = to12h(h, m)
  const mins = isDelivery ? (WINDOW_MINUTES[String(windowKey || 'exact')] || 0) : 0
  if (mins === 0) return start
  const total = h * 60 + m + mins
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${start} - ${to12h(eh, em)}`
}
