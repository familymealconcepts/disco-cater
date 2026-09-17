/**
 * THE PRICE OF A NATIVE ORDER COMES FROM THE MENU, NOT FROM THE CART.
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
 * Native checkout computed its subtotal straight from the `price` fields in the
 * posted cart:
 *
 *     const base = Number(it.price) || 0            // fmItemsToNativeCart
 *     ...
 *     return round2(items.reduce((s, it) => s + it.price * it.quantity, 0))   // cartSubtotal
 *
 * Nothing re-read disco_menu_items, so the amount charged was whatever the
 * request said it should be. The checkout page is the only thing that put real
 * prices there, and a request does not have to come from the checkout page — the
 * same reasoning this file's neighbours already apply to dates and menus:
 * "the picker only hides invalid options, it doesn't stop a direct API call from
 * requesting one."
 *
 * ── WHY REFUSING AN UNRESOLVABLE ITEM IS SAFE ───────────────────────────────
 * Of 371 native order lines in the last 90 days, 363 resolve to a live menu item
 * on their own restaurant, and ZERO were charged a price differing from today's
 * menu price — so this changes nothing about how real orders price. The 8 that
 * do not resolve are all July/August test orders against since-deleted test
 * items (Concierge Test "Bagels", Francesca "Test Item"). An item that is not on
 * the restaurant's menu right now cannot be ordered right now.
 *
 * ── ADD-ONS ─────────────────────────────────────────────────────────────────
 * Add-on prices are re-read the same way, and a modifier must be attached to THE
 * ITEM IT IS BEING ADDED TO through an enabled, visible group. Checking only that
 * the modifier exists would let a cheap option from another item be attached to
 * an expensive one.
 *
 * Legacy carts sent add-ons without a `reference`. Those are matched by name
 * within the item's own groups instead — the same fallback the minimums gate
 * already documents — and refused if the name matches nothing.
 */
import { sql } from '../db'
import type { NativeCartItem } from './native-checkout'

export type RepriceResult =
  | { ok: true; items: NativeCartItem[]; corrected: number }
  | { ok: false; status: number; error: string }

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function repriceCartFromMenu(restaurantReference: string, items: NativeCartItem[]): Promise<RepriceResult> {
  if (!items?.length) return { ok: true, items, corrected: 0 }

  const refs = items.map(i => i.reference).filter((r): r is string => !!r && UUID_RE.test(r))
  if (refs.length !== items.length) {
    const nameless = items.find(i => !i.reference || !UUID_RE.test(i.reference))
    return { ok: false, status: 400, error: `“${nameless?.name || 'An item'}” could not be matched to this restaurant's menu. Please refresh the menu and rebuild your order.` }
  }

  const menuRows = (await sql`
    SELECT i.reference::text AS reference, i.name, i.price::float8 AS price, i.visible,
           COALESCE(c.visible, true) AS category_visible
      FROM disco_menu_items i
      LEFT JOIN disco_menu_categories c ON c.reference = i.category_reference
     WHERE i.restaurant_reference::text = ${restaurantReference}
       AND i.reference::text = ANY(${refs})
  `) as Array<{ reference: string; name: string; price: number; visible: boolean; category_visible: boolean }>
  const byRef = new Map(menuRows.map(r => [r.reference, r]))

  // Every modifier reachable from these items, with the item it hangs off.
  const modRows = (await sql`
    SELECT ig.item_reference::text AS item_reference, m.reference::text AS reference,
           m.name, m.price::float8 AS price
      FROM disco_item_groups ig
      JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND g.archived = false AND g.visible = true
      JOIN disco_modifier_group_members gm ON gm.group_reference = ig.group_reference
      JOIN disco_modifiers m ON m.reference = gm.modifier_reference AND m.archived = false AND m.visible = true
     WHERE ig.enabled = true AND ig.item_reference::text = ANY(${refs})
  `.catch(() => [])) as Array<{ item_reference: string; reference: string; name: string; price: number }>
  const modsByItem = new Map<string, Array<{ reference: string; name: string; price: number }>>()
  for (const m of modRows) {
    if (!modsByItem.has(m.item_reference)) modsByItem.set(m.item_reference, [])
    modsByItem.get(m.item_reference)!.push({ reference: m.reference, name: m.name, price: m.price })
  }

  let corrected = 0
  const out: NativeCartItem[] = []
  for (const it of items) {
    const menu = byRef.get(it.reference!)
    if (!menu) {
      return { ok: false, status: 409, error: `“${it.name}” is no longer on this restaurant's menu. Please refresh the menu and rebuild your order.` }
    }
    if (!menu.visible || !menu.category_visible) {
      return { ok: false, status: 409, error: `“${menu.name}” is not currently available. Please refresh the menu and rebuild your order.` }
    }

    const available = modsByItem.get(it.reference!) || []
    const addOns: NonNullable<NativeCartItem['addOns']> = []
    for (const a of it.addOns || []) {
      const hit = a.reference
        ? available.find(m => m.reference === a.reference)
        : available.find(m => m.name.trim().toLowerCase() === String(a.name || '').trim().toLowerCase())
      if (!hit) {
        return { ok: false, status: 409, error: `The option “${a.name}” is not available on “${menu.name}”. Please refresh the menu and rebuild your order.` }
      }
      if (Math.abs(hit.price - (Number(a.price) || 0)) > 0.005) corrected++
      addOns.push({ ...a, name: hit.name, price: hit.price, reference: hit.reference })
    }

    const base = menu.price
    if (Math.abs(base - (Number(it.basePrice ?? it.price) || 0)) > 0.005) corrected++
    const addOnTotal = addOns.reduce((s, a) => s + a.price * a.quantity, 0)
    out.push({
      ...it,
      // The menu's name too: a cart cannot rename what it is buying.
      name: menu.name,
      basePrice: base,
      // Folded unit price, exactly as fmItemsToNativeCart builds it.
      price: round2(base + addOnTotal),
      addOns: addOns.length ? addOns : undefined,
    })
  }

  return { ok: true, items: out, corrected }
}
