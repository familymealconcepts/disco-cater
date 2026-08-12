import { sql } from './db'

// Restaurants created before timezone capture existed (or via paths that never
// asked) have no value here — 98% of disco_restaurant_cache does (3999/4082 as
// of 2026-08-12). Falling back to UTC would silently reintroduce the exact bug
// this file exists to fix, so every caller that needs a timezone falls back to
// this instead: FM's own overwhelming default for this business (every real
// example seen this session — Glen Rock, Elmwood Park, Atlanta Bread, Smyrna,
// Concierge Test — is America/New_York; the few America/Los_Angeles ones are
// still a real IANA zone, never absent). Callers must report which restaurants
// actually hit this fallback rather than silently trusting it.
export const DEFAULT_RESTAURANT_TIMEZONE = 'America/New_York'

export async function getRestaurantTimezone(restaurantRef: string): Promise<{ timezone: string; wasFallback: boolean }> {
  const rows = (await sql`SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${restaurantRef} LIMIT 1`.catch(() => [])) as { timezone: string | null }[]
  const tz = rows[0]?.timezone
  return tz ? { timezone: tz, wasFallback: false } : { timezone: DEFAULT_RESTAURANT_TIMEZONE, wasFallback: true }
}

// Find the UTC instant that displays as the given wall-clock date's start
// (00:00:00.000) or end (23:59:59.999) in `timeZone`. Used so a promo code's
// valid_from/valid_until match what the restaurant actually typed in ITS OWN
// day, not UTC's — a bare 'YYYY-MM-DD'::timestamptz cast is read as UTC
// midnight by Postgres, cutting a US-timezone promo off hours early.
export function localDayBoundaryToUTC(dateStr: string, timeZone: string, endOfDay: boolean): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const hh = endOfDay ? 23 : 0, mm = endOfDay ? 59 : 0, ss = endOfDay ? 59 : 0, ms = endOfDay ? 999 : 0
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss, ms))
  // 3 iterations is enough to converge across a DST jump at the boundary — each
  // pass re-reads the wall-clock time the current guess displays as in
  // `timeZone` and corrects by the residual, which shrinks to 0 once the
  // guess's own UTC-offset matches the offset actually in effect at that time.
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(guess)
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
    const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'), ms)
    const target = Date.UTC(y, m - 1, d, hh, mm, ss, ms)
    guess = new Date(guess.getTime() + (target - asUTC))
  }
  return guess
}
