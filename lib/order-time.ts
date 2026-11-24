// ORDER TIMES IN THE RESTAURANT'S OWN TIME ZONE (Peter, 2026-11-24).
//
// WHY. An order's placed / created / updated / edited / refunded / paid time is an INSTANT. Screens formatted it with the viewer's
// browser zone (no timeZone) or a hardcoded America/New_York, so a California or Texas restaurant saw its orders "placed" at Eastern
// times. Every place an order instant is shown now formats it here, in the time zone saved on the restaurant
// (disco_restaurant_cache.timezone), with the zone's abbreviation: "Nov 24, 9:15 AM PST".
//
// WHAT IT IS NOT FOR. The pickup/delivery date and time (order_date + order_time) are stored as the restaurant's own wall clock and
// are shown as stored; they must never pass through here (that would shift them a second time).
//
// FALLBACK. A restaurant with no saved zone (or an unreadable one) is shown in Eastern, the same default as lib/timezone.ts
// (DEFAULT_RESTAURANT_TIMEZONE, which can't be imported here because that file imports the database client and this one also runs
// in the browser). The abbreviation always says which zone was used, so a fallback is visible rather than silent.
//
// Display only: nothing here reads or changes stored data, and report date ranges are untouched.

export const ORDER_TIME_FALLBACK_TZ = 'America/New_York'

const validZones = new Map<string, boolean>()

/** The zone to format in: the restaurant's own when it is a real IANA zone, else Eastern. */
export function orderTimeZone(tz?: string | null): string {
  const z = (tz ?? '').trim()
  if (!z) return ORDER_TIME_FALLBACK_TZ
  let ok = validZones.get(z)
  if (ok === undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); ok = true } catch { ok = false }
    validZones.set(z, ok)
  }
  return ok ? z : ORDER_TIME_FALLBACK_TZ
}

/**
 * An instant from any of the shapes order payloads carry: a Date, epoch ms, an ISO string, a Postgres timestamptz string, or
 * FamilyMeal's "DD.MM.YYYY HH:mm" (which FM sends in UTC). Null when unreadable.
 */
export function parseOrderInstant(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d }
  const s = String(v).trim()
  const fm = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (fm) {
    const d = new Date(Date.UTC(Number(fm[3]), Number(fm[2]) - 1, Number(fm[1]), Number(fm[4] || 0), Number(fm[5] || 0), Number(fm[6] || 0)))
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'dayPeriod' | 'timeZoneName', string>

const formatters = new Map<string, Intl.DateTimeFormat>()
function partsIn(d: Date, tz: string): Parts {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    })
    formatters.set(tz, f)
  }
  const out = { year: '', month: '', day: '', hour: '', minute: '', dayPeriod: '', timeZoneName: '' } as Parts
  for (const p of f.formatToParts(d)) if (p.type in out) out[p.type as keyof Parts] = p.value
  return out
}

export type OrderTimeOptions = {
  /** 'auto' (default): the year only when it isn't the current year in that zone. */
  year?: 'auto' | 'always' | 'never'
  /** Clock now, for tests. */
  now?: Date
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A DATE with no time ("2026-11-24", FamilyMeal's "24.11.2026") is a calendar day, not an instant: converting it would move it to the
 * previous day west of UTC. Returned as "Nov 24, 2026" without any zone; null when the value has a time.
 */
export function dateOnlyLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
  m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[1])}, ${m[3]}`
  return null
}

/** "Nov 24, 9:15 AM PST" (or "Nov 24, 2025, 9:15 AM PST" in another year), in the restaurant's zone. '' when unreadable. */
export function formatOrderTime(v: unknown, tz?: string | null, opts: OrderTimeOptions = {}): string {
  const dayOnly = dateOnlyLabel(v)
  if (dayOnly) return dayOnly
  const d = parseOrderInstant(v)
  if (!d) return ''
  const zone = orderTimeZone(tz)
  const p = partsIn(d, zone)
  const year = opts.year ?? 'auto'
  const showYear = year === 'always' || (year === 'auto' && p.year !== partsIn(opts.now ?? new Date(), zone).year)
  return `${p.month} ${p.day}${showYear ? `, ${p.year}` : ''}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`
}

/** The time alone, "9:15 AM PST", in the restaurant's zone. */
export function formatOrderClock(v: unknown, tz?: string | null): string {
  const d = parseOrderInstant(v)
  if (!d) return ''
  const p = partsIn(d, orderTimeZone(tz))
  return `${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`
}

/** The calendar day an instant falls on in the restaurant's zone, "Nov 24, 2026". */
export function formatOrderDay(v: unknown, tz?: string | null): string {
  const dayOnly = dateOnlyLabel(v)
  if (dayOnly) return dayOnly
  const d = parseOrderInstant(v)
  if (!d) return ''
  const p = partsIn(d, orderTimeZone(tz))
  return `${p.month} ${p.day}, ${p.year}`
}

/** The calendar day as YYYY-MM-DD in the restaurant's zone (for grouping and CSV date columns). */
export function orderDayKey(v: unknown, tz?: string | null): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim()
  const d = parseOrderInstant(v)
  if (!d) return ''
  return d.toLocaleDateString('en-CA', { timeZone: orderTimeZone(tz) })
}
