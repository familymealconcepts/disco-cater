// Scheduled-report scheduling and date windows, computed in the REPORT'S OWN
// TIMEZONE.
//
// ── WHAT THIS REPLACES, AND WHY ─────────────────────────────────────────────
// reportPeriod() used to be three lines:
//     const to = now.toISOString().slice(0, 10)
//     const days = frequency === 'MONTHLY' ? 31 : 7
//     const from = new Date(now.getTime() - days * 86400000)...
// which carried three separate defects, all of them visible in every report
// sent to date:
//
//   1. IT INCLUDED TODAY. `to` was the current date, so every report ended on a
//      partial day — a Monday 09:00 weekly report contained nine hours of
//      Monday. Orders placed later that Monday appeared in NEITHER that report
//      nor the next one (which started from the following Monday), so they fell
//      through the gap entirely.
//   2. "MONTHLY" WAS 31 DAYS, not a calendar month. On a 30-day month it
//      double-counted a day; across a year it drifted continuously, and no
//      monthly report ever lined up with the month a restaurant was reconciling
//      against.
//   3. IT COMPUTED IN UTC while isReportDue fires on the restaurant's local
//      wall clock. A report firing 09:00 America/New_York got a window cut at
//      UTC midnight — four or five hours adrift depending on DST, which silently
//      moved orders between reports twice a year.
//
// Everything here works on PLAIN CIVIL DATES (y/m/d) read out of the timezone,
// never on instants, so DST cannot shift a boundary: a day is a day regardless
// of whether it contained 23 or 25 hours.
//
// The window is always INCLUSIVE at both ends and always ends on or before
// YESTERDAY, matching the SQL (`BETWEEN from AND to`) in order-report-rows.ts.

/** A plain civil date. No instant, no timezone, no DST. */
export interface Ymd { y: number; m: number; d: number }

export type RangeType =
  | 'PREVIOUS_PERIOD'
  | 'LAST_7_DAYS'
  | 'LAST_14_DAYS'
  | 'LAST_30_DAYS'
  | 'LAST_90_DAYS'
  | 'MONTH_TO_DATE'
  | 'QUARTER_TO_DATE'
  | 'YEAR_TO_DATE'
  | 'ROLLING_N_DAYS'

export const RANGE_LABELS: Record<RangeType, string> = {
  PREVIOUS_PERIOD: 'Previous complete period',
  LAST_7_DAYS: 'Last 7 days',
  LAST_14_DAYS: 'Last 14 days',
  LAST_30_DAYS: 'Last 30 days',
  LAST_90_DAYS: 'Last 90 days',
  MONTH_TO_DATE: 'Month to date',
  QUARTER_TO_DATE: 'Quarter to date',
  YEAR_TO_DATE: 'Year to date',
  ROLLING_N_DAYS: 'Rolling N days',
}

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY'

/** Day-of-month for a MONTHLY report: 1–28, or the literal last day. */
export const LAST_DAY_OF_MONTH = 'LAST'

// ── civil-date helpers ───────────────────────────────────────────────────────
// Arithmetic goes through Date.UTC purely as a calendar: UTC has no DST, so
// adding -1 day to a civil date can never land on the same or a skipped day.

function toUtc(x: Ymd): number {
  return Date.UTC(x.y, x.m - 1, x.d)
}
function fromUtc(ms: number): Ymd {
  const d = new Date(ms)
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }
}
export function addDays(x: Ymd, n: number): Ymd {
  return fromUtc(toUtc(x) + n * 86400000)
}
export function ymdToIso(x: Ymd): string {
  return `${String(x.y).padStart(4, '0')}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`
}
/** 0=Sun..6=Sat for a civil date. */
export function weekdayOf(x: Ymd): number {
  return new Date(toUtc(x)).getUTCDay()
}
/** Days in the month containing `x`. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/**
 * The wall-clock parts of `now` in `timezone`. This is the ONLY place an instant
 * becomes a civil date; everything downstream is plain date arithmetic.
 */
export function localNow(now: Date, timezone: string): Ymd & { weekday: number; hour: number } {
  const tz = timezone || 'America/New_York'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(now)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  // Intl can render midnight as "24" in some locales/engines; % 24 normalises it.
  const hour = Number(get('hour')) % 24
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    weekday: WD[get('weekday')] ?? 0,
    hour: Number.isFinite(hour) ? hour : 0,
  }
}

export interface PeriodSpec {
  rangeType?: string | null
  rangeDays?: number | null
  frequency: Frequency
  timezone: string
}

/**
 * The [from, to] a report covers, as inclusive ISO dates in its own timezone.
 *
 * ALWAYS ends on or before yesterday — a scheduled report never reports on a day
 * that is still in progress. PREVIOUS_PERIOD follows the frequency, so "monthly"
 * means the previous CALENDAR month rather than a rolling 31 days.
 */
export function resolvePeriod(spec: PeriodSpec, now: Date): { from: string; to: string } {
  const today = localNow(now, spec.timezone)
  const yesterday = addDays(today, -1)
  const rangeType = (spec.rangeType || 'PREVIOUS_PERIOD') as RangeType

  const lastN = (n: number) => ({ from: ymdToIso(addDays(yesterday, -(n - 1))), to: ymdToIso(yesterday) })

  switch (rangeType) {
    case 'LAST_7_DAYS': return lastN(7)
    case 'LAST_14_DAYS': return lastN(14)
    case 'LAST_30_DAYS': return lastN(30)
    case 'LAST_90_DAYS': return lastN(90)
    case 'ROLLING_N_DAYS': {
      // Never trusted: an absent, zero, negative or unparseable value falls back
      // to 30 days rather than producing an inverted window that would silently
      // match no rows and email an empty sheet. Upper bound keeps one report
      // from scanning years of orders.
      const raw = Math.floor(Number(spec.rangeDays))
      const n = Number.isFinite(raw) && raw > 0 ? Math.min(400, raw) : 30
      return lastN(n)
    }
    case 'MONTH_TO_DATE': {
      const start: Ymd = { y: today.y, m: today.m, d: 1 }
      // On the 1st there is no completed day this month yet — fall back to the
      // whole previous month rather than emitting an inverted window.
      if (toUtc(yesterday) < toUtc(start)) return previousCalendarMonth(today)
      return { from: ymdToIso(start), to: ymdToIso(yesterday) }
    }
    case 'QUARTER_TO_DATE': {
      const qStartMonth = Math.floor((today.m - 1) / 3) * 3 + 1
      const start: Ymd = { y: today.y, m: qStartMonth, d: 1 }
      if (toUtc(yesterday) < toUtc(start)) return previousCalendarMonth(today)
      return { from: ymdToIso(start), to: ymdToIso(yesterday) }
    }
    case 'YEAR_TO_DATE': {
      const start: Ymd = { y: today.y, m: 1, d: 1 }
      if (toUtc(yesterday) < toUtc(start)) return previousCalendarMonth(today)
      return { from: ymdToIso(start), to: ymdToIso(yesterday) }
    }
    case 'PREVIOUS_PERIOD':
    default: {
      if (spec.frequency === 'DAILY') {
        return { from: ymdToIso(yesterday), to: ymdToIso(yesterday) }
      }
      if (spec.frequency === 'MONTHLY') {
        return previousCalendarMonth(today)
      }
      // WEEKLY — the last COMPLETE Monday..Sunday, never the partial week in
      // progress. From a Monday this is the seven days that just ended.
      const daysSinceMonday = (weekdayOf(today) + 6) % 7   // Mon=0 … Sun=6
      const thisMonday = addDays(today, -daysSinceMonday)
      const lastSunday = addDays(thisMonday, -1)
      const lastMonday = addDays(lastSunday, -6)
      return { from: ymdToIso(lastMonday), to: ymdToIso(lastSunday) }
    }
  }
}

function previousCalendarMonth(today: Ymd): { from: string; to: string } {
  const m = today.m === 1 ? 12 : today.m - 1
  const y = today.m === 1 ? today.y - 1 : today.y
  return { from: ymdToIso({ y, m, d: 1 }), to: ymdToIso({ y, m, d: daysInMonth(y, m) }) }
}

/** A human description of the window, for the UI and the email body. */
export function describeRange(rangeType: string | null | undefined, frequency: Frequency, rangeDays?: number | null): string {
  const rt = (rangeType || 'PREVIOUS_PERIOD') as RangeType
  if (rt === 'PREVIOUS_PERIOD') {
    if (frequency === 'DAILY') return 'Yesterday'
    if (frequency === 'MONTHLY') return 'Previous calendar month'
    return 'Previous complete week (Mon–Sun)'
  }
  if (rt === 'ROLLING_N_DAYS') return `Last ${Math.max(1, Math.floor(Number(rangeDays) || 30))} days`
  return RANGE_LABELS[rt] ?? 'Previous complete period'
}

// ── due check ────────────────────────────────────────────────────────────────

export interface ScheduleSpec {
  frequency: string
  time: string
  timezone: string
  weekday?: number | null          // 0=Sun..6=Sat, WEEKLY only
  day_of_month?: string | number | null  // 1..28 or 'LAST', MONTHLY only
  last_run_at?: string | Date | null
}

/**
 * Is this report due at `now`?
 *
 * The cron is HOURLY, so this resolves to the hour and no finer. The stored time
 * keeps its HH:MM shape for compatibility, but the minutes have never been
 * honoured and the picker no longer offers them — an interface that accepts a
 * value it cannot act on is a lie, and one live report is saved as 08:56.
 */
export function isReportDue(report: ScheduleSpec, now: Date): boolean {
  const targetHour = Number(String(report.time || '09:00').split(':')[0]) || 0
  const { weekday, d: day, hour, y, m } = localNow(now, report.timezone)
  if (hour !== targetHour) return false

  const freq = String(report.frequency || 'WEEKLY').toUpperCase()
  let dayMatch: boolean
  if (freq === 'DAILY') {
    dayMatch = true
  } else if (freq === 'MONTHLY') {
    const dom = report.day_of_month ?? 1
    if (String(dom).toUpperCase() === LAST_DAY_OF_MONTH) {
      dayMatch = day === daysInMonth(y, m)
    } else {
      // Capped at 28 on save, so this cannot silently skip February.
      dayMatch = day === (Number(dom) || 1)
    }
  } else {
    // WEEKLY — an explicit weekday, defaulting to Monday to match every report
    // configured before the choice existed.
    const want = report.weekday == null ? 1 : Number(report.weekday)
    dayMatch = weekday === want
  }
  if (!dayMatch) return false

  if (report.last_run_at) {
    const since = now.getTime() - new Date(report.last_run_at).getTime()
    // 20h for weekly/monthly (a same-occurrence re-fire guard). DAILY needs a
    // tighter bound or it would skip every other day: consecutive daily runs are
    // 24h apart, but a DST shift makes one pair 23h, which 20h still clears
    // while remaining well above the 1h cron interval.
    const guardMs = (String(report.frequency).toUpperCase() === 'DAILY' ? 20 : 20) * 3600 * 1000
    if (since < guardMs) return false
  }
  return true
}
