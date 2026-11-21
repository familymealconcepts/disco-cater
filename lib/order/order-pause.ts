// "Pause new orders" (Peter, 2026-11-21) — a restaurant setting that refuses every NEW order until a
// chosen date, on every menu and every path, while existing orders are untouched and still fulfilled.
//
// STORED on disco_restaurant_overrides:
//   orders_paused_until          DATE   — the day ordering RESUMES (exclusive). NULL = not paused.
//                                          "Paused through Nov 26" is stored as 2026-11-27, so the
//                                          customer message reads "Not accepting new orders until
//                                          Friday, November 27." and the setting needs no second date.
//   orders_pause_excluded_menus  TEXT[] — disco_menus references that KEEP taking orders during the
//                                          pause (optional). Their own schedule/cutoff still applies.
//
// ACTIVE while the restaurant's local date (disco_restaurant_cache.timezone) is before
// orders_paused_until. It lapses by itself — nothing has to switch it off on the resume date.
//
// THE PAUSE IS ABOUT WHEN AN ORDER IS PLACED, not the date it is for: during the pause an order for
// any future date is refused too. Edits to existing orders never come through these checks (the edit
// route reprices on its own and never calls placeNativeOrder / buildNativePlaceInput).
//
// WHICH MENU AN ORDER IS FOR is worked out on the server from each item's own category
// (disco_menu_items → disco_menu_categories.menu_reference), never from the client's menuReference
// tag, so a cart cannot claim an excluded menu for items that live on a paused one. An item whose
// menu cannot be resolved (an untagged recurring snapshot, an FM-backed cart) counts as NOT excluded
// — the pause fails closed.
//
// Every caller: lib/order/native-place-checkout.ts (customer checkout, the /order link, staff direct
// entry, invoices), lib/order/native-checkout.ts placeNativeOrder (backstop for all three native
// placement paths incl. recurring), app/api/cron/recurring-orders (before the occurrence is claimed or
// charged), lib/restaurant-orderable.ts (FM-backed proxy routes + the storefront), and the storefront
// banner / per-menu notice in app/(customer)/restaurants/[slug]/shared.tsx.
import { sql } from '../db'

export interface OrderPauseState {
  /** YYYY-MM-DD the restaurant resumes taking orders, or null. */
  pausedUntil: string | null
  excludedMenus: string[]
  timezone: string
  /** True right now (restaurant-local date before pausedUntil). */
  active: boolean
  /** Customer-facing, e.g. "Not accepting new orders until Friday, November 27." ('' when inactive). */
  message: string
}

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/** "Friday, November 27" for a YYYY-MM-DD. */
export function pauseDateLabel(iso: string): string {
  if (!ISO_RE.test(iso)) return iso
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return `${WD[dt.getUTCDay()]}, ${MO[m - 1]} ${d}`
}

export function pauseMessage(pausedUntil: string): string {
  return `Not accepting new orders until ${pauseDateLabel(pausedUntil)}.`
}

/** Today in the restaurant's zone, YYYY-MM-DD. */
export function localToday(tz: string, now: Date = new Date()): string {
  try { return now.toLocaleDateString('en-CA', { timeZone: tz || 'America/New_York' }) }
  catch { return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) }
}

/** Pure rule, exported for tests. */
export function isPauseActive(pausedUntil: string | null | undefined, tz: string, now: Date = new Date()): boolean {
  if (!pausedUntil || !ISO_RE.test(pausedUntil)) return false
  return localToday(tz, now) < pausedUntil
}

function toIso(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v).slice(0, 10)
  return ISO_RE.test(s) ? s : null
}

export function buildPauseState(pausedUntil: unknown, excluded: unknown, timezone: unknown, now: Date = new Date()): OrderPauseState {
  const until = toIso(pausedUntil)
  const tz = String(timezone || '') || 'America/New_York'
  const excludedMenus = Array.isArray(excluded) ? excluded.map(String).filter(Boolean) : []
  const active = isPauseActive(until, tz, now)
  return { pausedUntil: until, excludedMenus, timezone: tz, active, message: active && until ? pauseMessage(until) : '' }
}

/**
 * The pause as stored. A missing column (cold database before runMigrations added it) reads as "not
 * paused" ONLY for that specific error; any other failure throws so the caller fails closed.
 */
export async function readOrderPause(restaurantReference: string): Promise<OrderPauseState> {
  if (!restaurantReference) return buildPauseState(null, [], null)
  let rows: Record<string, unknown>[]
  try {
    rows = (await sql`
      SELECT o.orders_paused_until::text AS until, o.orders_pause_excluded_menus AS excluded, c.timezone
        FROM disco_restaurant_cache c
        LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
       WHERE c.restaurant_reference = ${restaurantReference}
       LIMIT 1
    `) as Record<string, unknown>[]
  } catch (e) {
    if (/orders_paused_until|orders_pause_excluded_menus/.test(e instanceof Error ? e.message : String(e))) return buildPauseState(null, [], null)
    throw e
  }
  const r = rows[0]
  return buildPauseState(r?.until, r?.excluded, r?.timezone)
}

/** Server-side menu of each disco_menu_items reference (null when it cannot be resolved). */
async function menusOfItems(itemReferences: string[]): Promise<Map<string, string | null>> {
  const refs = [...new Set(itemReferences.filter(Boolean))]
  const out = new Map<string, string | null>(refs.map((r) => [r, null]))
  if (!refs.length) return out
  const rows = (await sql`
    SELECT mi.reference::text AS item, c.menu_reference::text AS menu
      FROM disco_menu_items mi
      JOIN disco_menu_categories c ON c.reference::text = mi.category_reference::text
     WHERE mi.reference::text = ANY(${refs})
  `) as { item: string; menu: string | null }[]
  for (const r of rows) out.set(r.item, r.menu)
  return out
}

export type PauseCheck = { blocked: false } | { blocked: true; message: string; pausedUntil: string }

/**
 * Should a NEW order with these items be refused? `itemReferences` are disco_menu_items references
 * (pass [] when unknown). Not paused → never blocked. Paused with no excluded menus → always blocked.
 * Paused with excluded menus → allowed only when EVERY line resolves to an excluded menu.
 * `lineCount` is the number of cart lines, so a line with no reference at all cannot slip through.
 */
export async function checkOrderPause(restaurantReference: string, itemReferences: (string | null | undefined)[], lineCount = itemReferences.length): Promise<PauseCheck> {
  const p = await readOrderPause(restaurantReference)
  if (!p.active || !p.pausedUntil) return { blocked: false }
  const blocked = { blocked: true as const, message: p.message, pausedUntil: p.pausedUntil }
  if (!p.excludedMenus.length) return blocked
  const refs = itemReferences.filter((r): r is string => !!r)
  if (!refs.length || refs.length < lineCount) return blocked
  const menus = await menusOfItems(refs)
  const excluded = new Set(p.excludedMenus)
  return refs.every((r) => { const m = menus.get(r); return !!m && excluded.has(m) }) ? { blocked: false } : blocked
}

/** Thrown by the placement backstop; callers already turn a thrown placement error into a refusal. */
export class OrderPausedError extends Error {
  constructor(message: string) { super(message); this.name = 'OrderPausedError' }
}
