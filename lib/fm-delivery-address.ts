// FamilyMeal delivery address + delivery instructions → disco_orders.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// FamilyMeal's order LIST carries no delivery address, so every FM delivery
// order reached disco_orders without one (5,076 of 5,077 on 2026-10-25), and
// most without their delivery instructions. FM's per-order detail
// (GET /public-api/v2/orders/{ref}/details → data.order.deliveryAddress) has
// both, and the sync already fetches that detail for new orders it copies items
// for — it just never kept the address. Example: Bagel Point - Brooklyn
// #53240374, delivering to 288 N 8th St with "call cathy when you get there".
//
// ── WHAT IT WRITES ──────────────────────────────────────────────────────────
// ONLY empty fields, ONLY on FM-copied DELIVERY orders:
//   • the address (line 1, line 2, city, state, zip) as one unit, and only when
//     line 1 is empty — never half an FM address on top of an address Disco
//     already holds;
//   • delivery_instructions, only when empty.
// Nothing else: no money, status, tips, fees, payouts, dates or updated_at.
// FamilyMeal is only READ.
//
// ── LINE 1 ──────────────────────────────────────────────────────────────────
// FM's addressLine1 is a whole formatted address ("288 N 8th St, Brooklyn, NY
// 11211, USA") with city/state/zip ALSO in their own fields. Disco's own orders
// keep only the street in line 1, and every surface (order drawer, PDF, emails,
// Super Admin) appends city/state/zip itself — so a verbatim copy would print
// "288 N 8th St, Brooklyn, NY 11211, USA, Brooklyn, NY 11211". streetOnly()
// removes that tail ONLY when its "ST zip" matches FM's own state and zip, and
// then only the one locality field before it (FM's city — or, for Manhattan,
// "New York" where the city field says "Manhattan"); anything else is kept
// verbatim, and the street itself is never removed.
//
// ── "LOOKED, FM HAD NONE" ───────────────────────────────────────────────────
// When FM answers and the order genuinely has no address, line 1 is set to ''
// (still empty to every reader) so the catch-up stops asking FM about it. A
// failed or timed-out lookup writes nothing, so the next run tries again.

import { sql } from './db'
import { getFmServiceAuthHeader } from './fm-service-auth'
import { fmFetch } from './fm-fetch'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export interface FmDeliveryAddress {
  line1: string
  line2: string | null
  city: string | null
  state: string | null
  zip: string | null
  instructions: string | null
}

function str(v: unknown): string { return typeof v === 'string' ? v : (v == null ? '' : String(v)) }

const COUNTRY_RE = /^(?:usa?|u\.s\.a?\.?|united states(?: of america)?)$/i

/** FM's line 1 without a trailing ", City, ST zip[, USA]" that repeats its own
 *  state/zip fields. Returned verbatim unless state and zip match. */
export function streetOnly(line1: string, city: string | null, state: string | null, zip: string | null): string {
  const fields = line1.split(',').map(f => f.trim()).filter(Boolean)
  if (fields.length && COUNTRY_RE.test(fields[fields.length - 1])) fields.pop()
  const eq = (a: string, b: string | null) => !!b && a.toLowerCase() === b.trim().toLowerCase()
  const st = (state || '').trim(), z = (zip || '').trim()
  if (!st || !z) return line1.trim()
  // "City, ST zip" or "City, ST, zip"
  let n = fields.length
  if (n >= 2 && eq(fields[n - 1], `${st} ${z}`)) n -= 1
  else if (n >= 3 && eq(fields[n - 1], z) && eq(fields[n - 2], st)) n -= 2
  else return line1.trim()
  // The locality before it. Usually FM's own city; for Manhattan FM writes "New
  // York" here and "Manhattan" in the city field — the field that is shown.
  if (n >= 2) n -= 1
  else return line1.trim()
  return fields.slice(0, n).join(', ')
}

/** The address on an FM order-detail response; null when the order has none. */
export function fmDeliveryAddressFrom(details: Record<string, unknown> | null | undefined): FmDeliveryAddress | null {
  const order = (((details?.data as Record<string, unknown>)?.order as Record<string, unknown>)
    ?? (details?.order as Record<string, unknown>)
    ?? details) as Record<string, unknown> | null | undefined
  const a = order?.deliveryAddress as Record<string, unknown> | null | undefined
  if (!a || typeof a !== 'object') return null
  const city = str(a.city).trim() || null
  const state = str(a.state).trim() || null
  const zip = (str(a.zipCode) || str(a.zipcode)).trim() || null
  const raw1 = str(a.addressLine1).trim()
  const instructions = str(a.deliveryInstructions) || null
  if (!raw1 && !instructions) return null
  return {
    line1: raw1 ? streetOnly(raw1, city, state, zip) : '',
    line2: str(a.addressLine2).trim() || null,
    city, state, zip, instructions,
  }
}

/**
 * Fill the empty address/instruction fields of one FM-copied delivery order from
 * an FM detail response already in hand. No FM call. Returns what it did.
 * `markNone` records "FM answered, no address" (line 1 = '') — used only by
 * callers that queried FM specifically for the address.
 */
export async function fillDeliveryAddress(
  orderId: number, details: Record<string, unknown> | null, opts: { markNone?: boolean } = {},
): Promise<'filled' | 'none' | 'kept'> {
  const a = fmDeliveryAddressFrom(details)
  if (!a) {
    if (opts.markNone && details) {
      await sql`
        UPDATE disco_orders SET delivery_address_line1 = ''
        WHERE id = ${orderId} AND order_type = 'DELIVERY' AND fm_order_reference IS NOT NULL
          AND delivery_address_line1 IS NULL
      `
    }
    return 'none'
  }
  const hasAddr = a.line1 !== ''
  const rows = (await sql`
    UPDATE disco_orders o SET
      delivery_address_line1 = CASE WHEN COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr} THEN ${a.line1} ELSE o.delivery_address_line1 END,
      delivery_address_line2 = CASE WHEN COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr} AND COALESCE(o.delivery_address_line2, '') = '' THEN ${a.line2} ELSE o.delivery_address_line2 END,
      delivery_city  = CASE WHEN COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr} AND COALESCE(o.delivery_city, '')  = '' THEN ${a.city}  ELSE o.delivery_city END,
      delivery_state = CASE WHEN COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr} AND COALESCE(o.delivery_state, '') = '' THEN ${a.state} ELSE o.delivery_state END,
      delivery_zip   = CASE WHEN COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr} AND COALESCE(o.delivery_zip, '')   = '' THEN ${a.zip}   ELSE o.delivery_zip END,
      delivery_instructions = CASE WHEN COALESCE(o.delivery_instructions, '') = '' THEN ${a.instructions} ELSE o.delivery_instructions END
    WHERE o.id = ${orderId} AND o.order_type = 'DELIVERY' AND o.fm_order_reference IS NOT NULL
      AND ((COALESCE(o.delivery_address_line1, '') = '' AND ${hasAddr})
        OR (COALESCE(o.delivery_instructions, '') = '' AND ${a.instructions}::text IS NOT NULL))
    RETURNING o.id
  `) as { id: number }[]
  if (!hasAddr && opts.markNone) {
    await sql`
      UPDATE disco_orders SET delivery_address_line1 = ''
      WHERE id = ${orderId} AND order_type = 'DELIVERY' AND fm_order_reference IS NOT NULL
        AND delivery_address_line1 IS NULL
    `
  }
  return rows.length ? 'filled' : 'kept'
}

/** One read-only FM order-detail lookup. null on any failure (retry later). */
export async function fetchFmOrderDetail(fmRef: string, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
  try {
    const auth = await getFmServiceAuthHeader()
    const res = await fmFetch(`${FM}/public-api/v2/orders/${fmRef}/details`, { headers: { ...auth, Accept: 'application/json' }, cache: 'no-store' }, timeoutMs)
    if (!res.ok) return null
    return (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch { return null }
}

/**
 * Catch-up for NEW FM delivery orders whose address isn't in Disco yet — the
 * ones copied without a detail fetch (historical-shaped pulls), or whose fetch
 * failed. Upcoming orders first, then the newest. One lookup per order, one at a
 * time, capped and time-boxed; a failure is skipped and retried next run.
 * Older orders are the one-off backfill's job (scripts/fm-delivery-address-backfill.ts).
 */
export async function fillMissingDeliveryAddresses(opts: { cap?: number; budgetMs?: number } = {}): Promise<{ candidates: number; filled: number; none: number; failed: number }> {
  const cap = opts.cap ?? 15
  const deadline = Date.now() + (opts.budgetMs ?? 20_000)
  const rows = (await sql`
    SELECT id, fm_order_reference::text AS fm_ref
    FROM disco_orders
    WHERE order_type = 'DELIVERY' AND fm_order_reference IS NOT NULL AND is_deleted = false
      AND delivery_address_line1 IS NULL
      AND (order_date >= CURRENT_DATE OR created_at > NOW() - INTERVAL '3 days')
    ORDER BY (order_date >= CURRENT_DATE) DESC, order_date ASC, id DESC
    LIMIT ${cap}
  `) as { id: number; fm_ref: string }[]
  let filled = 0, none = 0, failed = 0
  for (const r of rows) {
    if (Date.now() > deadline) break
    const remaining = deadline - Date.now()
    const details = await fetchFmOrderDetail(r.fm_ref, Math.min(15_000, Math.max(1_000, remaining)))
    if (!details) { failed++; continue }
    try {
      const res = await fillDeliveryAddress(r.id, details, { markNone: true })
      if (res === 'filled') filled++
      else if (res === 'none') none++
    } catch (e) {
      failed++
      console.error('[fm-delivery-address] fill failed:', r.id, e instanceof Error ? e.message : e)
    }
  }
  return { candidates: rows.length, filled, none, failed }
}
