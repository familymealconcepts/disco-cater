import { cookies } from 'next/headers'

// ── Customer auth ──────────────────────────────────────────────────────────
// The diner JWT lives in the `disco_token` cookie (set by /api/fm-auth). FM's
// backend derives the acting user from this token, so the `reference` claim is
// the trustworthy customer FM reference. Mirrors lib/restaurant-auth.ts.

export interface CustomerIdentity {
  reference: string
  email: string
  firstName: string
  lastName: string
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

// Returns the logged-in customer's identity from the disco_token cookie, or
// null when there is no usable token / reference.
export async function getCustomer(): Promise<CustomerIdentity | null> {
  const store = await cookies()
  const token = store.get('disco_token')?.value
  if (!token) return null
  const payload = decodeJwt(token)
  if (!payload) return null
  const reference = (payload.reference as string) || (payload.sub as string) || ''
  if (!reference) return null
  return {
    reference,
    email: (payload.email as string) || (payload.sub as string) || '',
    firstName: (payload.firstName as string) || '',
    lastName: (payload.lastName as string) || '',
  }
}

// ── Occurrence generation ───────────────────────────────────────────────────

export type FrequencyType = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'
export type EndKind = 'NEVER' | 'COUNT' | 'DATE'

export interface GeneratedOccurrence {
  scheduledDate: string // YYYY-MM-DD
  scheduledTime: null
}

const DAY_INDEX: Record<string, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
}

// All date math is done in UTC to avoid local-timezone drift on DATE values.
function parseUTC(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}

// The date of the Nth <weekday> in a given month (month is 0-based). Returns
// null when that ordinal does not exist (e.g. a 5th Monday in a short month).
function nthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): Date | null {
  const firstOfMonth = new Date(Date.UTC(year, month, 1))
  const offset = (weekday - firstOfMonth.getUTCDay() + 7) % 7
  const day = 1 + offset + (ordinal - 1) * 7
  const candidate = new Date(Date.UTC(year, month, day))
  if (candidate.getUTCMonth() !== month) return null
  return candidate
}

/**
 * Build the schedule of future occurrence dates for a recurring order.
 *
 * - WEEKLY:   every 7 days, anchored to `repeatEveryDay`
 * - BIWEEKLY: every 14 days, anchored to `repeatEveryDay`
 * - MONTHLY:  the same ordinal weekday each month (e.g. 2nd Monday)
 *
 * Generates at most 12 months out. Stops early when `endKind === 'COUNT'`
 * (after `endCount` dates) or `endKind === 'DATE'` (once past `endDate`).
 */
export function generateOccurrences(
  frequencyType: FrequencyType,
  startDate: string,
  repeatEveryDay: string,
  endKind: EndKind,
  endCount: number | null,
  endDate: string | null
): GeneratedOccurrence[] {
  const weekday = DAY_INDEX[repeatEveryDay?.toUpperCase()]
  const start = parseUTC(startDate)

  // First occurrence: the first date on/after startDate that lands on the
  // requested weekday (a no-op when startDate already is that weekday).
  let first = start
  if (weekday !== undefined) {
    const diff = (weekday - start.getUTCDay() + 7) % 7
    first = addDays(start, diff)
  }

  // 12-month horizon, measured from startDate.
  const cap = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 12, start.getUTCDate()))
  const hardEnd = endKind === 'DATE' && endDate ? parseUTC(endDate) : null
  const maxCount = endKind === 'COUNT' && endCount ? endCount : Infinity

  const out: GeneratedOccurrence[] = []

  if (frequencyType === 'WEEKLY' || frequencyType === 'BIWEEKLY') {
    const step = frequencyType === 'WEEKLY' ? 7 : 14
    for (let cur = first; out.length < maxCount && cur <= cap; cur = addDays(cur, step)) {
      if (hardEnd && cur > hardEnd) break
      out.push({ scheduledDate: fmt(cur), scheduledTime: null })
    }
  } else if (frequencyType === 'MONTHLY') {
    const wd = weekday ?? first.getUTCDay()
    const ordinal = Math.floor((first.getUTCDate() - 1) / 7) + 1
    let year = first.getUTCFullYear()
    let month = first.getUTCMonth()
    // Guard against runaway loops; 13 months covers the 12-month horizon.
    for (let i = 0; i < 13 && out.length < maxCount; i++) {
      const occ = nthWeekdayOfMonth(year, month, wd, ordinal)
      if (occ && occ >= first) {
        if (occ > cap) break
        if (hardEnd && occ > hardEnd) break
        out.push({ scheduledDate: fmt(occ), scheduledTime: null })
      }
      month++
      if (month > 11) {
        month = 0
        year++
      }
    }
  }

  return out
}

// ── Menu availability ────────────────────────────────────────────────────────
// Used by POST /api/recurring-orders/[id]/check-menu and the daily cron's menu
// pass. Compares a recurring order's cart against the restaurant's CURRENT
// public FM menu and reports any items that have since been removed.

const FM_API = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export interface CartItem {
  name?: string
  quantity?: number
  price?: number
}

export interface MenuAvailability {
  available: boolean
  unavailableItems: string[]
}

interface MealPackageLike {
  name?: string
  mealPackages?: MealPackageLike[]
}

function normName(s: string): string {
  return s.trim().toLowerCase()
}

// All meal-package names on a restaurant's public menu. The public endpoint
// usually returns a flat array of packages, but some FM responses nest them
// under categories — collect names from both shapes.
async function fetchMenuItemNames(restaurantReference: string): Promise<string[]> {
  const res = await fetch(`${FM_API}/public-api/restaurants/${restaurantReference}/mealPackages`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`FM mealPackages ${res.status}`)
  const data = (await res.json()) as MealPackageLike[] | unknown
  const names: string[] = []
  const collect = (pkg: MealPackageLike) => {
    if (pkg?.name) names.push(String(pkg.name))
    if (Array.isArray(pkg?.mealPackages)) pkg.mealPackages!.forEach(collect)
  }
  if (Array.isArray(data)) data.forEach(collect)
  return names
}

/**
 * Compare a cart against the restaurant's current menu.
 *
 * Throws when the menu can't be fetched OR comes back empty — callers should
 * treat that as "couldn't determine" rather than "everything is gone", so a
 * transient FM hiccup never falsely pauses a recurring order.
 */
export async function checkMenuAvailability(
  restaurantReference: string,
  cart: CartItem[],
): Promise<MenuAvailability> {
  const menuNames = await fetchMenuItemNames(restaurantReference)
  if (menuNames.length === 0) throw new Error('FM returned an empty menu')
  const menuSet = new Set(menuNames.map(normName))
  const wanted = (cart || []).map((i) => i?.name).filter(Boolean) as string[]
  const unavailableItems = wanted.filter((n) => !menuSet.has(normName(n)))
  return { available: unavailableItems.length === 0, unavailableItems }
}
