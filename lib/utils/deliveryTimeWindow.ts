import { formatTime12 } from './time'
// Delivery Order Time Windows — mirrors FM's `timeRangeFormat` pipe
// (familymeal-platform time-range-format-pipe.ts).
//
// FM's restaurant-level `deliveryOrderTimeWindows` setting (FM's own valid
// values: 'exact' | '30_min' | '1_hour'; Disco adds '15_min', which FM never
// sends and the FM importer therefore still rejects) controls how the order
// time is DISPLAYED for
// DELIVERY orders: a range "start - (start + window)" instead of an exact time.
// PICKUP orders always show the exact start time. The stored order time is
// always the START time — the range is display-only.
//
// ── THE DEFAULT IS 'exact', AND THE CALLER RESOLVES THE REAL ONE ───────────
// This used to default to '30_min', on the reasoning that Disco had no UI for
// the per-restaurant setting so every order's windowKey was unset anyway. That
// reasoning expired: there are now two editors for it (order-settings and
// menu-manager/settings), and the default outlived them.
//
// What it cost: delivery_time_window is NULL on 5,039 of 5,196 recent delivery
// orders, so the confirmation email and the PDF — which pass that snapshot —
// fell back to a 30-minute range, while the order page read the restaurant's
// live setting and showed an exact time. Same order, two answers, on 18
// upcoming orders at the time this was found. Ops first saw the same shape of
// inconsistency in FamilyMeal; Disco had its own version of it.
//
// A missing windowKey now means 'exact' — no range invented from nothing. When
// an order has no stored window, the CALLER is responsible for resolving the
// restaurant's current setting first (lib/order/native-checkout.ts's
// loadDeliveryTimeWindow), so the fallback chain is: the order's own snapshot,
// then the restaurant's setting now, then exact.
// '15_min' is Disco's own addition. It is the only option that lines up exactly
// with the 15-minute booking grid (SLOT_MINUTES in lib/scheduling/cutoffs.ts):
// adjacent slots produce contiguous windows rather than the overlapping ones
// 30_min and 1_hour give (12:00-12:30 beside 12:15-12:45).
const WINDOW_MINUTES: Record<string, number> = { exact: 0, '15_min': 15, '30_min': 30, '1_hour': 60 }

// Delegates to the shared formatter so the window range and every other
// 12-hour label in the app cannot drift apart.
function to12h(h: number, m: number): string {
  return formatTime12(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
}

// startTime: "HH:mm" (24h). windowKey: 'exact' | '15_min' | '30_min' | '1_hour' | null.
// null/absent → 'exact'. See the header: resolving the restaurant's setting is
// the caller's job, because only the caller knows which restaurant this is.
// isDelivery: only DELIVERY orders get the range (FM's `deliveryType` guard).
export function formatTimeWindow(
  startTime: string,
  windowKey?: string | null,
  isDelivery?: boolean,
): string {
  const [h, m] = String(startTime || '').split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return String(startTime || '')
  const start = to12h(h, m)
  const mins = isDelivery ? (WINDOW_MINUTES[String(windowKey || 'exact')] ?? 0) : 0
  if (mins === 0) return start
  const total = h * 60 + m + mins
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${start} - ${to12h(eh, em)}`
}
