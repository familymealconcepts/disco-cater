// Server-side enforcement of the two MINIMUM concepts FM carries on a menu item,
// neither of which had any server gate before this module.
//
//   1. disco_menu_items.min_quantity  — FM `mealPackage.minQuantity`. "Minimum 4
//      people" on Atlanta Bread's Sides, 10 on Asheville's breakfast trays, 30 on
//      Francesca's holiday packages. The restaurant does not make the item below
//      that count.
//   2. disco_modifier_groups.min_selected — FM `extraItemsGroups[].minSelectedItems`.
//      "Select 2 Salads", "Select 4+ Sandwiches", "Select Packaging Type" (1).
//
// Both values import faithfully (verified: 0 mismatches against FM across all nine
// Atlanta Bread locations) and both are sent to the browser. The item minimum was
// then read by nothing at all — the quantity stepper floored at 1 — so a customer
// could order 2 of a min-4 item and reach payment with a cart the kitchen cannot
// fill. That is not hypothetical: the cart lost on 2026-08-27 (orders
// 900000099-101) held 2x Italian Pasta Salad and 2x Fruit Salad, both min 4.
//
// The group minimum WAS enforced, but only client-side (RestaurantClient's
// isGroupValid gating "Add to Order"), which is a button, not an enforcement —
// Direct Entry and any direct API call bypassed it entirely.
import { sql } from '../db'

/**
 * Item minimums for a restaurant, keyed by LOWERCASED ITEM NAME.
 *
 * Name-keyed rather than reference-keyed because the one caller that needs it —
 * the recurring-occurrence cart editor — holds a cart snapshot that carries only
 * names (subscriptions/page.tsx maps `{ name, quantity, price }`; the item
 * reference is dropped before it ever reaches the client, and the recurring cron
 * rebuilds its cart the same way). So a name is the only join available there.
 *
 * On a name collision across menus this takes the LOWEST minimum, deliberately.
 * A client-side floor that over-states the minimum would block a legitimate order;
 * one that under-states it only fails to help. Reference-exact enforcement lives in
 * checkCartMinimums, which every reference-carrying path goes through.
 */
export async function getItemMinimumsByName(restaurantReference: string): Promise<Record<string, number>> {
  if (!restaurantReference) return {}
  const rows = (await sql`
    SELECT mi.name, MIN(mi.min_quantity) AS min_quantity
    FROM disco_menu_items mi
    JOIN disco_menu_categories c ON c.reference = mi.category_reference
    JOIN disco_menus m ON m.reference = c.menu_reference AND m.archived = false AND m.visible = true
    WHERE mi.restaurant_reference = ${restaurantReference}::uuid
      AND mi.visible = true AND mi.min_quantity IS NOT NULL AND mi.min_quantity > 1
    GROUP BY mi.name
  `.catch(() => [])) as { name: string; min_quantity: number }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[String(r.name).trim().toLowerCase()] = Number(r.min_quantity)
  return out
}

export interface MinimumCheckItem {
  reference?: string
  name: string
  quantity: number
  // groupReference is the exact tie from a selection back to its modifier group,
  // carried through fmItemsToNativeCart. `name` is the fallback for clients that
  // don't send it.
  addOns?: { name: string; quantity: number; groupReference?: string }[]
}

export interface MinimumViolation {
  kind: 'ITEM_MIN_QUANTITY' | 'GROUP_MIN_SELECTED'
  itemName: string
  required: number
  actual: number
  groupLabel?: string
}

export type MinimumCheckResult =
  | { ok: true }
  | { ok: false; violation: MinimumViolation; message: string }

const qty = (v: unknown) => Math.max(1, Math.trunc(Number(v) || 1))

/**
 * Diner-facing wording. Mirrors how the add-on group picker states its own
 * requirement ("Select exactly 2", "Select 4–100") so a refusal reads like the
 * hint the customer was already shown, rather than a different vocabulary.
 */
function messageFor(v: MinimumViolation): string {
  if (v.kind === 'ITEM_MIN_QUANTITY') {
    return `“${v.itemName}” has a minimum of ${v.required} — you have ${v.actual}. Please increase the quantity to ${v.required} or more.`
  }
  return `“${v.itemName}” needs ${v.required === 1 ? 'a selection' : `${v.required} selections`} for “${v.groupLabel}” — you have ${v.actual}.`
}

/**
 * Refuse a cart that violates an item minimum or a required-group minimum.
 *
 * ITEM MINIMUMS ARE SUMMED ACROSS LINES, not checked per line. One cart can list
 * the same item more than once (two packaging choices, say), and the kitchen sees
 * the total portions. 2 + 2 of a min-4 item is four portions and is allowed;
 * checking per line would refuse a cart the restaurant can actually fill, and a
 * false refusal is worse than none. Same reasoning (and the same comment) as
 * checkItemInventoryAvailability.
 *
 * GROUP MINIMUMS ARE EXACT when the cart tags its selections with a group
 * reference, which the current client always does — CheckoutDrawer and
 * RestaurantClient both send `extraItemsGroupReference` (lib/pricing/checkout.ts's
 * mapAddOn puts it on the wire); fmItemsToNativeCart was simply dropping it, so it
 * is now carried through as `groupReference`.
 *
 * For a payload with no group identity at all (a legacy client, or a hand-built
 * request), this falls back to matching selections to groups BY NAME, and where a
 * name is ambiguous — the same option name sitting in two required groups on the
 * same item — it SKIPS that group rather than guessing, because a wrong guess
 * blocks a legitimate order.
 *
 * Returns the FIRST violation found, matching how every other gate in
 * buildNativePlaceInput reports (one actionable message, not a list).
 */
export async function checkCartMinimums(items: MinimumCheckItem[]): Promise<MinimumCheckResult> {
  const refs = Array.from(new Set((items || []).map(i => i.reference).filter((r): r is string => !!r)))
  if (refs.length === 0) return { ok: true }

  // ── 1) Item minimum quantity ────────────────────────────────────────────────
  const mins = (await sql`
    SELECT reference, name, min_quantity
    FROM disco_menu_items
    WHERE reference = ANY(${refs}::uuid[]) AND min_quantity IS NOT NULL AND min_quantity > 1
  `.catch(() => [])) as { reference: string; name: string; min_quantity: number }[]

  if (mins.length) {
    const minByRef = new Map(mins.map(m => [m.reference, m]))
    const requestedByRef = new Map<string, number>()
    for (const it of items) {
      if (!it.reference || !minByRef.has(it.reference)) continue
      requestedByRef.set(it.reference, (requestedByRef.get(it.reference) || 0) + qty(it.quantity))
    }
    for (const [ref, requested] of requestedByRef) {
      const m = minByRef.get(ref)!
      if (requested < m.min_quantity) {
        const violation: MinimumViolation = {
          kind: 'ITEM_MIN_QUANTITY', itemName: m.name, required: m.min_quantity, actual: requested,
        }
        return { ok: false, violation, message: messageFor(violation) }
      }
    }
  }

  // ── 2) Required modifier-group minimums ─────────────────────────────────────
  // Only groups actually ATTACHED to a cart item, only required ones (min > 0),
  // and only non-archived + visible — the same filter the customer menu applies,
  // so a hidden group can never block an order it isn't offering.
  const groups = (await sql`
    SELECT ig.item_reference, g.reference AS group_reference, g.name, g.external_name, g.min_selected
    FROM disco_item_groups ig
    JOIN disco_modifier_groups g
      ON g.reference = ig.group_reference AND g.archived = false AND g.visible = true
    WHERE ig.enabled = true AND ig.item_reference = ANY(${refs}::uuid[]) AND g.min_selected > 0
  `.catch(() => [])) as {
    item_reference: string; group_reference: string; name: string; external_name: string | null; min_selected: number
  }[]
  if (!groups.length) return { ok: true }

  const groupRefs = Array.from(new Set(groups.map(g => g.group_reference)))
  const members = (await sql`
    SELECT gm.group_reference, m.name
    FROM disco_modifier_group_members gm
    JOIN disco_modifiers m ON m.reference = gm.modifier_reference AND m.archived = false AND m.visible = true
    WHERE gm.group_reference = ANY(${groupRefs}::uuid[])
  `.catch(() => [])) as { group_reference: string; name: string }[]

  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
  const namesByGroup = new Map<string, Set<string>>()
  for (const m of members) {
    const set = namesByGroup.get(m.group_reference) ?? new Set<string>()
    set.add(norm(m.name))
    namesByGroup.set(m.group_reference, set)
  }
  const groupsByItem = new Map<string, typeof groups>()
  for (const g of groups) {
    const l = groupsByItem.get(g.item_reference) ?? []
    l.push(g)
    groupsByItem.set(g.item_reference, l)
  }

  // Per LINE, not summed: each line is one configured instance of the item, and
  // its selections belong to that instance.
  for (const it of items) {
    if (!it.reference) continue
    const itemGroups = groupsByItem.get(it.reference)
    if (!itemGroups?.length) continue
    const selected = (it.addOns || []).map(a => ({
      name: norm(a.name), quantity: qty(a.quantity), groupReference: a.groupReference,
    }))
    // Exact mode whenever the cart tagged its selections with a group reference —
    // the modern client always does. Name matching (and its ambiguity skip) is only
    // the fallback for a payload that carries no group identity at all.
    const exact = selected.some(s => !!s.groupReference)

    for (const g of itemGroups) {
      const memberNames = namesByGroup.get(g.group_reference)
      if (!memberNames?.size) continue   // group with no options can't be satisfied or violated

      let count: number
      if (exact) {
        count = selected.reduce((a, s) => a + (s.groupReference === g.group_reference ? s.quantity : 0), 0)
      } else {
        // Ambiguity check: if any of this group's option names also belongs to
        // ANOTHER required group on the same item, a name cannot identify which
        // group a selection was made in. Skip rather than guess — a wrong guess
        // blocks a legitimate order.
        const ambiguous = itemGroups.some(other =>
          other.group_reference !== g.group_reference &&
          [...(namesByGroup.get(other.group_reference) ?? [])].some(n => memberNames.has(n)))
        if (ambiguous) continue
        count = selected.reduce((a, s) => a + (memberNames.has(s.name) ? s.quantity : 0), 0)
      }

      if (count < g.min_selected) {
        const violation: MinimumViolation = {
          kind: 'GROUP_MIN_SELECTED',
          itemName: it.name,
          groupLabel: g.external_name || g.name,
          required: g.min_selected,
          actual: count,
        }
        return { ok: false, violation, message: messageFor(violation) }
      }
    }
  }

  return { ok: true }
}
