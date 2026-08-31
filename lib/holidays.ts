// US holidays with date rules, used to PRE-COMPUTE the actual calendar date of each
// holiday for a range of years (holidays land on different dates each year). A
// restaurant toggles a holiday closed and we store every year's date, so
// "Thanksgiving 2026", "Thanksgiving 2027", … are all blocked from ordering.

export const HOLIDAY_YEARS = 50

// Canonical closable holidays (matches FM's SYSTEM_HOLIDAYS set + Juneteenth,
// without FM's "July 4th"/"Independence Day" duplicate).
export const HOLIDAYS: string[] = [
  "New Year's Day",
  'Martin Luther King Jr. Day',
  "Valentine's Day",
  "Presidents' Day",
  'Easter',
  'Memorial Day',
  'Juneteenth',
  'Independence Day',
  'Labor Day',
  'Thanksgiving Day',
  'Christmas Eve',
  'Christmas Day',
  "New Year's Eve",
]

const isHolidayName = (name: string) => HOLIDAYS.includes(name)
export { isHolidayName }

/**
 * FM's own spellings → Disco's canonical name.
 *
 * FM names several of these differently, and the differences are NOT cosmetic:
 * an unrecognised name is stored with `holiday = NULL`, which files a real
 * holiday as a one-off custom closure. It then (a) shows the Closed Holidays
 * checkbox UNTICKED while the restaurant is in fact closed, and (b) keeps only
 * the handful of years FM carried instead of Disco's 50.
 *
 * "Valentines Day" was the one this map missed. All six DeCheco's locations
 * carried their Valentine's closure across as an orphan: 4 rows each, 2024-2027,
 * so from 2028 they would have been silently OPEN on a day they close. Found
 * 2026-08-31, backfilled by scripts/backfill-valentines-holiday.ts.
 *
 * Add to this map rather than renaming anything in HOLIDAYS — the canonical
 * names are what the `holiday` column already stores fleet-wide.
 */
export const FM_HOLIDAY_NAME_ALIASES: Record<string, string> = {
  "President's Day": "Presidents' Day",
  'Easter Day': 'Easter',
  'Valentines Day': "Valentine's Day",
  'July 4th': 'Independence Day',
}

/** FM's name for a holiday → Disco's canonical one. Unknown names pass through. */
export function canonicalHolidayName(rawName: string): string {
  const n = (rawName || '').trim()
  return FM_HOLIDAY_NAME_ALIASES[n] || n
}

/**
 * Does this name — in FM's spelling or Disco's — denote a system holiday?
 *
 * THE FM-BACKED SETTINGS PAGE USES THIS AS A CLASSIFIER, not as a source of
 * checkboxes. That page renders whatever FM's /closedDays returns; this only
 * decides whether an entry appears under the holiday TOGGLES or under Custom
 * Dates (which render a DELETE button instead). So the set must be a SUPERSET of
 * every name FM might emit: widening it is safe, narrowing it is not — an
 * unmatched holiday drops into Custom Dates and offers the restaurant a delete
 * where it meant to offer a toggle.
 *
 * That is why 'July 4th' is kept alongside 'Independence Day' even though FM has
 * only ever been observed emitting the latter, and why Juneteenth is included
 * even though FM does not offer it.
 */
export function isFmSystemHolidayName(rawName: string | null | undefined): boolean {
  const n = (rawName || '').trim()
  if (!n) return false
  return isHolidayName(n) || n in FM_HOLIDAY_NAME_ALIASES
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (y: number, month0: number, day: number) => `${y}-${pad(month0 + 1)}-${pad(day)}`

// Weekday of a Y/M/D in UTC (0=Sun..6=Sat) — avoids local-timezone drift.
const weekdayOf = (y: number, month0: number, day: number) => new Date(Date.UTC(y, month0, day)).getUTCDay()

// The nth (1-based) `weekday` of a month. weekday: 0=Sun..6=Sat.
function nthWeekday(y: number, month0: number, weekday: number, n: number): [number, number, number] {
  const firstDow = weekdayOf(y, month0, 1)
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7
  return [y, month0, day]
}
// The last `weekday` of a month.
function lastWeekday(y: number, month0: number, weekday: number): [number, number, number] {
  const lastDay = new Date(Date.UTC(y, month0 + 1, 0)).getUTCDate()
  const lastDow = weekdayOf(y, month0, lastDay)
  const day = lastDay - ((lastDow - weekday + 7) % 7)
  return [y, month0, day]
}
// Western (Gregorian) Easter Sunday — Anonymous Gregorian computus.
function easter(y: number): [number, number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)   // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return [y, month - 1, day]
}

const MON = 1, THU = 4
const RULES: Record<string, (y: number) => [number, number, number]> = {
  "New Year's Day": y => [y, 0, 1],
  'Martin Luther King Jr. Day': y => nthWeekday(y, 0, MON, 3),
  "Valentine's Day": y => [y, 1, 14],
  "Presidents' Day": y => nthWeekday(y, 1, MON, 3),
  'Easter': y => easter(y),
  'Memorial Day': y => lastWeekday(y, 4, MON),
  'Juneteenth': y => [y, 5, 19],
  'Independence Day': y => [y, 6, 4],
  'Labor Day': y => nthWeekday(y, 8, MON, 1),
  'Thanksgiving Day': y => nthWeekday(y, 10, THU, 4),
  'Christmas Eve': y => [y, 11, 24],
  'Christmas Day': y => [y, 11, 25],
  "New Year's Eve": y => [y, 11, 31],
}

// Every ISO date (YYYY-MM-DD) for `name` across `count` years starting at `fromYear`.
export function holidayDates(name: string, fromYear: number, count = HOLIDAY_YEARS): string[] {
  const rule = RULES[name]
  if (!rule) return []
  const out: string[] = []
  for (let y = fromYear; y < fromYear + count; y++) {
    const [yy, mm, dd] = rule(y)
    out.push(fmt(yy, mm, dd))
  }
  return out
}
