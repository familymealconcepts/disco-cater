import { cookies } from 'next/headers'
import { getCustomerSession } from './customer-auth'

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

// Returns the logged-in customer's identity. Prefers the legacy disco_token FM
// JWT (decoded for the FM reference); falls back to the Disco-native customer
// session (disco_customer_token) so Neon-backed routes keep working even when no
// FM JWT is present (e.g. FM was down at login).
export async function getCustomer(): Promise<CustomerIdentity | null> {
  const store = await cookies()
  const token = store.get('disco_token')?.value
  if (token) {
    const payload = decodeJwt(token)
    const reference = (payload?.reference as string) || (payload?.sub as string) || ''
    if (reference) {
      return {
        reference,
        email: (payload?.email as string) || (payload?.sub as string) || '',
        firstName: (payload?.firstName as string) || '',
        lastName: (payload?.lastName as string) || '',
      }
    }
  }

  // Disco-native session fallback.
  const session = await getCustomerSession()
  if (session) {
    return {
      // No FM reference yet (FM-less account) → key Neon-owned data by email so
      // it stays internally consistent for this customer.
      reference: session.fmReference || session.email,
      email: session.email,
      firstName: session.firstName,
      lastName: session.lastName,
    }
  }
  return null
}

// ── Stripe identity extraction ───────────────────────────────────────────────
// FM's GET /api/users/payment/defaultSource returns the diner's saved card, but
// the exact field names for the underlying Stripe customer + payment method vary
// across FM deployments (and may be nested). Rather than guess the keys, scan
// every string value in the payload and match on Stripe's id prefixes — robust
// to whatever shape FM returns. Prefers a modern PaymentMethod (pm_), falling
// back to a legacy card/source id which Stripe still accepts off-session.
export function extractStripeIds(source: unknown): {
  stripeCustomerId: string | null
  stripePaymentMethodId: string | null
} {
  const strings: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk)
  }
  walk(source)
  const stripeCustomerId = strings.find(s => s.startsWith('cus_')) ?? null
  const stripePaymentMethodId =
    strings.find(s => s.startsWith('pm_'))
    ?? strings.find(s => s.startsWith('card_'))
    ?? strings.find(s => s.startsWith('src_'))
    ?? null
  return { stripeCustomerId, stripePaymentMethodId }
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

// Current price for each meal-package name on the restaurant's menu. Reads the
// same public mealPackages endpoint as the availability check, capturing the
// per-package price (FM uses `price`, sometimes `pricePerUnit`).
async function fetchMenuItemPrices(restaurantReference: string): Promise<Map<string, number>> {
  const res = await fetch(`${FM_API}/public-api/restaurants/${restaurantReference}/mealPackages`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`FM mealPackages ${res.status}`)
  const data = (await res.json()) as unknown
  const prices = new Map<string, number>()
  const collect = (pkg: Record<string, unknown>) => {
    const raw = pkg?.price ?? pkg?.pricePerUnit
    const price = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
    if (pkg?.name && Number.isFinite(price)) prices.set(normName(String(pkg.name)), price)
    if (Array.isArray((pkg as { mealPackages?: unknown })?.mealPackages)) {
      (pkg as { mealPackages: Record<string, unknown>[] }).mealPackages.forEach(collect)
    }
  }
  if (Array.isArray(data)) (data as Record<string, unknown>[]).forEach(collect)
  return prices
}

// Re-price a cart against the CURRENT menu (I5): each item matched by name gets
// the current price; an unmatched item — or any fetch failure / empty menu —
// keeps its snapshot price, so a transient issue or a renamed item never wildly
// mis-charges. Returns the (possibly) re-priced cart; the caller then sums it.
export async function repriceCart(restaurantReference: string, cart: CartItem[]): Promise<CartItem[]> {
  let prices: Map<string, number>
  try {
    prices = await fetchMenuItemPrices(restaurantReference)
  } catch {
    return cart || [] // couldn't fetch → charge the snapshot, never guess
  }
  if (prices.size === 0) return cart || []
  return (cart || []).map((it) => {
    const cur = it?.name ? prices.get(normName(it.name)) : undefined
    return cur != null ? { ...it, price: cur } : it
  })
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
