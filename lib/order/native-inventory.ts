// Max Inventory Per Day — a per-menu-ITEM daily unit cap (distinct from
// disco_menus.max_orders_per_day, which caps total ORDERS for a restaurant/day
// regardless of contents). NULL max_inventory_per_day = unlimited, and an
// uncapped item is never written to disco_menu_item_daily_inventory at all —
// none of this logic touches it.
//
// Two enforcement points:
//   1. checkItemInventoryAvailability — a best-effort pre-payment READ, right
//      before checkout, so an obviously-oversold cart is blocked before the
//      customer enters payment info. Always reads the LIVE cap (no caching),
//      so a restaurant lowering the cap takes effect on the very next attempt.
//   2. decrementMenuItemInventory — the actual enforcement, at payment success.
//      A single atomic UPDATE ... WHERE guards the increment against the live
//      cap in the SAME statement (not a separate read-then-write): two
//      concurrent payment-success events for the same item/day serialize on
//      Postgres's row lock, so the second can never push the total past the cap.
import { sql } from '../db'

export interface CapCheckItem { reference?: string | null; quantity: number }
export type CapCheckResult =
  | { ok: true }
  | { ok: false; itemName: string; remaining: number; requested: number }

// Best-effort pre-payment check. Only inspects cart items that carry a
// `reference` (native menu items) AND have max_inventory_per_day set — uncapped
// items and non-menu-item lines are skipped entirely.
export async function checkItemInventoryAvailability(items: CapCheckItem[], orderDate: string): Promise<CapCheckResult> {
  const refs = Array.from(new Set((items || []).map(i => i.reference).filter((r): r is string => !!r)))
  if (refs.length === 0 || !orderDate) return { ok: true }

  const capped = (await sql`
    SELECT mi.reference, mi.name, mi.max_inventory_per_day AS cap, COALESCE(d.ordered_qty, 0) AS ordered_qty
    FROM disco_menu_items mi
    LEFT JOIN disco_menu_item_daily_inventory d
      ON d.menu_item_reference = mi.reference AND d.order_date = ${orderDate}::date
    WHERE mi.reference = ANY(${refs}::uuid[]) AND mi.max_inventory_per_day IS NOT NULL
  `.catch(() => [])) as { reference: string; name: string; cap: number; ordered_qty: number }[]
  if (capped.length === 0) return { ok: true }

  const capByRef = new Map(capped.map(c => [c.reference, c]))
  // Sum requested quantity per item reference — a cart could list the same
  // item across more than one line (e.g. different add-on combos).
  const requestedByRef = new Map<string, number>()
  for (const it of items) {
    if (!it.reference || !capByRef.has(it.reference)) continue
    requestedByRef.set(it.reference, (requestedByRef.get(it.reference) || 0) + Math.max(1, Math.trunc(Number(it.quantity) || 1)))
  }

  for (const [ref, requested] of requestedByRef) {
    const c = capByRef.get(ref)!
    const remaining = c.cap - c.ordered_qty
    if (requested > remaining) {
      return { ok: false, itemName: c.name, remaining: Math.max(0, remaining), requested }
    }
  }
  return { ok: true }
}

// Live remaining stock for a set of items on a given date — the read the
// customer-facing cart uses to cap the quantity selector BEFORE checkout
// (UX only; the atomic decrement below is the real enforcement, since stock
// can still change between this read and payment). Only capped items with a
// max_inventory_per_day set are returned; uncapped refs are omitted entirely
// so the client never applies a limit to an uncapped item.
export async function getItemsRemaining(refs: string[], orderDate: string): Promise<Record<string, number>> {
  const uniqueRefs = Array.from(new Set(refs.filter(Boolean)))
  if (uniqueRefs.length === 0 || !orderDate) return {}
  const rows = (await sql`
    SELECT mi.reference, mi.max_inventory_per_day AS cap, COALESCE(d.ordered_qty, 0) AS ordered_qty
    FROM disco_menu_items mi
    LEFT JOIN disco_menu_item_daily_inventory d
      ON d.menu_item_reference = mi.reference AND d.order_date = ${orderDate}::date
    WHERE mi.reference = ANY(${uniqueRefs}::uuid[]) AND mi.max_inventory_per_day IS NOT NULL
  `.catch(() => [])) as { reference: string; cap: number; ordered_qty: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.reference] = Math.max(0, r.cap - r.ordered_qty)
  return out
}

// The real enforcement — an atomic conditional increment. Returns true when the
// increment applied (capacity was available), false when it didn't (cap
// exceeded — exhausted by a concurrent order in the same window). No-ops
// (returns true, writes nothing) when the item has no cap set.
export async function decrementMenuItemInventory(itemRef: string, orderDate: string, qty: number): Promise<boolean> {
  const capRows = (await sql`SELECT max_inventory_per_day AS cap FROM disco_menu_items WHERE reference = ${itemRef}::uuid LIMIT 1`) as { cap: number | null }[]
  const cap = capRows[0]?.cap
  if (cap == null) return true // uncapped — nothing to enforce, no row written

  // Ensure a counter row exists before the guarded increment below (idempotent;
  // a no-op if the row already exists from an earlier order the same day).
  await sql`
    INSERT INTO disco_menu_item_daily_inventory (menu_item_reference, order_date, ordered_qty)
    VALUES (${itemRef}::uuid, ${orderDate}::date, 0)
    ON CONFLICT (menu_item_reference, order_date) DO NOTHING
  `
  // Atomic conditional increment: the live cap is re-read via the subquery and
  // the row is locked for the duration of this single UPDATE, so the guard and
  // the write happen as one indivisible operation — not a separate check then a
  // separate write. RETURNING is empty iff the guard failed.
  const updated = (await sql`
    UPDATE disco_menu_item_daily_inventory
    SET ordered_qty = ordered_qty + ${qty}, updated_at = NOW()
    WHERE menu_item_reference = ${itemRef}::uuid AND order_date = ${orderDate}::date
      AND ordered_qty + ${qty} <= (SELECT COALESCE(max_inventory_per_day, 2147483647) FROM disco_menu_items WHERE reference = ${itemRef}::uuid)
    RETURNING ordered_qty
  `) as { ordered_qty: number }[]
  return updated.length > 0
}

// Compensating undo — used only when one item in a multi-item order succeeds
// but a LATER item in the same order fails, so the whole order must be treated
// as failed (applyOrderInventoryDecrements). Always safe: adding back exactly
// what was just subtracted can never itself violate the cap. A restaurant
// lowering the cap mid-day never reverses an order that already succeeded —
// this function only ever undoes a decrement from THIS SAME call, never touches
// a previously-committed order.
async function incrementMenuItemInventory(itemRef: string, orderDate: string, qty: number): Promise<void> {
  await sql`
    UPDATE disco_menu_item_daily_inventory
    SET ordered_qty = ordered_qty - ${qty}, updated_at = NOW()
    WHERE menu_item_reference = ${itemRef}::uuid AND order_date = ${orderDate}::date
  `
}

export interface OrderInventoryItem { itemRef: string; itemName: string; quantity: number }
export type ApplyResult = { ok: true } | { ok: false; failedItem: { reference: string; name: string } }

// Applies the atomic decrement for every item in a placed order (uncapped items
// no-op inside decrementMenuItemInventory, so passing the full item list is
// safe), all-or-nothing: if any item's decrement fails, every item that already
// succeeded earlier in THIS call is compensated back before returning failure —
// a partially-decremented order can never linger.
export async function applyOrderInventoryDecrements(items: OrderInventoryItem[], orderDate: string): Promise<ApplyResult> {
  const applied: OrderInventoryItem[] = []
  for (const it of items) {
    const ok = await decrementMenuItemInventory(it.itemRef, orderDate, it.quantity)
    if (!ok) {
      for (const done of applied) await incrementMenuItemInventory(done.itemRef, orderDate, done.quantity)
      return { ok: false, failedItem: { reference: it.itemRef, name: it.itemName } }
    }
    applied.push(it)
  }
  return { ok: true }
}
