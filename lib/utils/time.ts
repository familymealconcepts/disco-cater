// THE time display formatter. One implementation, so 12-hour rendering cannot
// drift the way it had: eight near-copies of this existed (portal orders,
// restaurant-customers, admin-manager-reports, admin manage-orders, customer
// OrderDetailPanel, the order-edit route, the recurring-orders cron and
// lib/order-edit), all emitting "h:mm AM/PM" but disagreeing at the edges —
// two produced the literal "NaN:NaN PM" for a malformed value, one skipped
// minute padding, and each had its own idea of what an empty input renders as.
//
// DISPLAY ONLY. Nothing here parses for storage, converts a zone, or touches a
// wire format. Times are stored and sent exactly as before; normalizeTime /
// toFmTime in _components/TimeSelect.tsx remain the wire normalizers, and this
// must never be used in their place.

export interface FormatTime12Options {
  /** Rendered when the value is empty. Defaults to ''. */
  fallback?: string
}

/**
 * "15:30" | "15:30:00" | "3:30 PM"(idempotent-ish) → "3:30 PM".
 *
 * Tolerates FM's non-padded "H:mm:ss" and any trailing seconds. An unparseable
 * non-empty value is returned unchanged rather than blanked or turned into
 * "NaN:NaN PM" — showing the raw value is bad, but hiding it is worse.
 */
export function formatTime12(t: string | null | undefined, opts?: FormatTime12Options): string {
  const raw = String(t ?? '').trim()
  if (!raw) return opts?.fallback ?? ''
  const m = /^(\d{1,2}):(\d{2})/.exec(raw)
  if (!m) return raw
  const h = Number(m[1])
  if (!Number.isFinite(h) || h > 23) return raw
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m[2]} ${ampm}`
}

/**
 * "15:30", "17:00" → "3:30 PM – 5:00 PM".
 *
 * Default separator is an en dash with spaces, matching the blackout summary
 * this replaced ("15:30–17:00"). Pass `separator` where a surrounding style
 * already uses a hyphen (the delivery window range uses " - ").
 */
export function formatTimeRange12(
  from: string | null | undefined,
  to: string | null | undefined,
  separator = ' – ',
): string {
  const a = formatTime12(from)
  const b = formatTime12(to)
  if (a && b) return `${a}${separator}${b}`
  return a || b
}
