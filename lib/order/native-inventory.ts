// Max Inventory Per Day — a per-menu-ITEM daily unit cap (distinct from
// disco_menus.max_orders_per_day, which caps total ORDERS for a restaurant/day
// regardless of contents). NULL max_inventory_per_day = unlimited — none of
// this logic touches an uncapped item.
//
// ── THE COUNT: READ FROM THE ORDERS, NOT A COUNTER ──────────────────────────
// orderedQtyByItem() is the single definition every surface uses (storefront
// "left for this date", the pre-payment check, the payment-success check):
// the sum of the item's order-line quantities over every order whose
// pickup/delivery date (disco_orders.order_date — a plain DATE that already is
// the restaurant-local day the customer picked) is that day and that has not
// been cancelled. "Cancelled" = COUNTED_EXCLUDED_STATUSES below; RESERVED (a
// checkout whose payment hasn't succeeded) is not an order yet, unless its
// payment has already succeeded.
//
// This replaced reading disco_menu_item_daily_inventory, a counter bumped at
// payment success (the table is left in place, unused). The bump never ran: its item query joined a uuid to a text column,
// Postgres refused it, and a .catch(() => []) turned the error into "no items".
// The table held ZERO rows fleet-wide, so every capped item showed its full cap
// and nothing was ever enforced (The Speakeatery's Turk Diggler: "Only 25 left"
// for 10/29 with 21 already sold). Counting from the orders also follows
// cancellations, refunds, edits, Direct Entry and invoices, which a counter
// bumped in one place never could.
//
// Enforcement points:
//   1. checkItemInventoryAvailability — pre-payment, at placement (customer
//      checkout and Direct Entry), with the live cap.
//   2. checkOrderInventoryAtPayment — at payment success, counting this order
//      plus every other counted order. Two payments for the same item settling
//      in the same instant: the later order (higher id) counts the earlier one
//      as soon as its payment is recorded, so a near-simultaneous pair can't both
//      pass; only a pair landing within the same few milliseconds could.
//   The order-edit route deliberately runs neither (the restaurant may take an
//   order past its own cap) — see app/api/restaurant/orders/[ref]/edit/route.ts.
import { sql } from '../db'

export interface CapCheckItem { reference?: string | null; quantity: number }
export type CapCheckResult =
  | { ok: true }
  | { ok: false; itemName: string; remaining: number; requested: number }

// Statuses whose orders do NOT use up stock. Everything else on the order's
// date counts (DUE, COMPLETED, PAID, UNPAID invoices, PARTIAL_REFUND, REOPEN).
const COUNTED_EXCLUDED_STATUSES = [
  'RESERVED', 'CANCELED', 'CANCELLED', 'VOID', 'VOIDED', 'REFUND', 'REFUNDED',
  'EXPIRED', 'PAYMENT_FAILED', 'CART', 'SELECTED',
]

/**
 * Units of each item already ordered for `orderDate`. Missing key = 0.
 * `excludeOrderId` leaves one order out; `asOfOrderId` additionally counts a
 * RESERVED order whose payment has succeeded only if it is older than that order
 * (the payment-success tie-break described at the top of this file).
 */
export async function orderedQtyByItem(
  refs: string[], orderDate: string, opts: { excludeOrderId?: number; asOfOrderId?: number } = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const unique = Array.from(new Set(refs.filter(Boolean).map(r => r.toLowerCase())))
  if (unique.length === 0 || !orderDate) return out
  const exclude = opts.excludeOrderId ?? null
  const asOf = opts.asOfOrderId ?? null
  const rows = (await sql`
    SELECT lower(oi.meal_package_reference) AS ref, SUM(oi.quantity)::int AS qty
    FROM disco_order_items oi
    JOIN disco_orders o ON o.id = oi.order_id
    WHERE lower(oi.meal_package_reference) = ANY(${unique}::text[])
      AND o.order_date = ${orderDate}::date
      AND o.is_deleted = false
      AND (${exclude}::bigint IS NULL OR o.id <> ${exclude}::bigint)
      AND (
        o.order_status <> ALL(${COUNTED_EXCLUDED_STATUSES}::text[])
        OR (o.order_status = 'RESERVED'
            AND (${asOf}::bigint IS NULL OR o.id < ${asOf}::bigint)
            AND EXISTS (SELECT 1 FROM disco_stripe_payments p
                        WHERE p.order_reference = o.reference AND p.status = 'SUCCEEDED'))
      )
    GROUP BY 1
  `) as { ref: string; qty: number }[]
  for (const r of rows) out.set(r.ref, Number(r.qty) || 0)
  return out
}

async function capsFor(refs: string[]): Promise<{ reference: string; name: string; cap: number }[]> {
  const unique = Array.from(new Set(refs.filter(Boolean)))
  if (unique.length === 0) return []
  return (await sql`
    SELECT mi.reference::text AS reference, mi.name, mi.max_inventory_per_day AS cap
    FROM disco_menu_items mi
    WHERE mi.reference::text = ANY(${unique.map(r => r.toLowerCase())}::text[]) AND mi.max_inventory_per_day IS NOT NULL
  `) as { reference: string; name: string; cap: number }[]
}

// Pre-payment check at placement. Only inspects cart items that carry a
// `reference` (native menu items) AND have max_inventory_per_day set — uncapped
// items and non-menu-item lines are skipped entirely.
export async function checkItemInventoryAvailability(items: CapCheckItem[], orderDate: string): Promise<CapCheckResult> {
  const refs = Array.from(new Set((items || []).map(i => i.reference).filter((r): r is string => !!r)))
  if (refs.length === 0 || !orderDate) return { ok: true }

  // Fail-open on a database error (as before), but loudly: a broken query must
  // not block every checkout — and must not hide either, which is how the old
  // counter stayed silently empty.
  let capped: Awaited<ReturnType<typeof capsFor>>
  let ordered: Map<string, number>
  try {
    capped = await capsFor(refs)
    if (capped.length === 0) return { ok: true }
    ordered = await orderedQtyByItem(capped.map(c => c.reference), orderDate)
  } catch (e) {
    console.error('[native-inventory] pre-payment cap check failed (allowing):', e instanceof Error ? e.message : e)
    return { ok: true }
  }

  const capByRef = new Map(capped.map(c => [c.reference.toLowerCase(), c]))
  // Sum requested quantity per item reference — a cart could list the same
  // item across more than one line (e.g. different add-on combos).
  const requestedByRef = new Map<string, number>()
  for (const it of items) {
    const key = it.reference?.toLowerCase()
    if (!key || !capByRef.has(key)) continue
    requestedByRef.set(key, (requestedByRef.get(key) || 0) + Math.max(1, Math.trunc(Number(it.quantity) || 1)))
  }

  for (const [ref, requested] of requestedByRef) {
    const c = capByRef.get(ref)!
    const remaining = c.cap - (ordered.get(ref) || 0)
    if (requested > remaining) {
      return { ok: false, itemName: c.name, remaining: Math.max(0, remaining), requested }
    }
  }
  return { ok: true }
}

// Live remaining stock for a set of items on a given date — the read the
// customer-facing cart uses to cap the quantity selector and show "Only N left
// for this date". Only capped items are returned; uncapped refs are omitted so
// the client never applies a limit to an uncapped item. Keys are the refs as
// the caller passed them.
export async function getItemsRemaining(refs: string[], orderDate: string): Promise<Record<string, number>> {
  const uniqueRefs = Array.from(new Set(refs.filter(Boolean)))
  if (uniqueRefs.length === 0 || !orderDate) return {}
  const capped = await capsFor(uniqueRefs)
  if (capped.length === 0) return {}
  const ordered = await orderedQtyByItem(capped.map(c => c.reference), orderDate)
  const capByRef = new Map(capped.map(c => [c.reference.toLowerCase(), c.cap]))
  const out: Record<string, number> = {}
  for (const r of uniqueRefs) {
    const cap = capByRef.get(r.toLowerCase())
    if (cap == null) continue
    out[r] = Math.max(0, cap - (ordered.get(r.toLowerCase()) || 0))
  }
  return out
}

export interface OrderInventoryItem { itemRef: string; itemName: string; quantity: number }
export type ApplyResult = { ok: true } | { ok: false; failedItem: { reference: string; name: string } }

// Payment-success check: this order's units plus every other counted order's
// must fit under each capped item's live cap. Uncapped items are ignored.
export async function checkOrderInventoryAtPayment(orderId: number, items: OrderInventoryItem[], orderDate: string): Promise<ApplyResult> {
  const capped = await capsFor(items.map(i => i.itemRef))
  if (capped.length === 0) return { ok: true }
  const others = await orderedQtyByItem(capped.map(c => c.reference), orderDate, { excludeOrderId: orderId, asOfOrderId: orderId })
  const mine = new Map<string, number>()
  for (const it of items) mine.set(it.itemRef.toLowerCase(), (mine.get(it.itemRef.toLowerCase()) || 0) + it.quantity)
  for (const c of capped) {
    const key = c.reference.toLowerCase()
    if ((others.get(key) || 0) + (mine.get(key) || 0) > c.cap) return { ok: false, failedItem: { reference: c.reference, name: c.name } }
  }
  return { ok: true }
}
