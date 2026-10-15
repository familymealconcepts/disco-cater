import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'
import { applyOrder, cleanRefs, UUID_RE } from '../../../../../lib/reorder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Move one item from one category to another, and set its place in the target.
 *
 * Body { itemReference, toCategoryReference, references[] } where `references`
 * is the full ordered list the target category should end up with, INCLUDING
 * the moved item. Same shape the reorder endpoint takes, so the client builds
 * the list the same way for both gestures.
 *
 * ── WHAT MOVES AND WHAT DOES NOT ────────────────────────────────────────────
 * Exactly two columns change: category_reference and position. Everything that
 * makes the item itself — name, description, price, display_price, serves,
 * image_url, min/max quantity, special instructions, every dietary flag,
 * visibility — lives on this same row and is not written here. Modifier groups
 * (disco_item_groups) and their members are keyed by item_reference, never by
 * category, so they follow the item without being touched at all. That is the
 * whole reason this is a move rather than a copy-and-delete: there is nothing
 * to copy.
 *
 * ── OWNERSHIP IS CHECKED ON BOTH CATEGORIES ─────────────────────────────────
 * A category carries no restaurant_reference of its own, so both the source and
 * the destination are resolved through their menu's restaurant, against the
 * caller's own scope. A reference belonging to another restaurant fails the
 * lookup and 404s — this adds no new way to reach anything, and deliberately
 * does not widen who may edit a menu: it is the same scope check the reorder
 * and item routes already apply, applied twice.
 *
 * The two categories may belong to DIFFERENT menus of the same restaurant, and
 * that is allowed — the menu manager shows one menu at a time, but nothing in
 * the data model ties an item to a menu except through its category.
 */
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Please sign in again to continue.' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: { itemReference?: unknown; toCategoryReference?: unknown; references?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  const itemRef = String(body?.itemReference ?? '')
  const toCat = String(body?.toCategoryReference ?? '')
  if (!UUID_RE.test(itemRef)) return NextResponse.json({ error: 'itemReference required' }, { status: 400 })
  if (!UUID_RE.test(toCat)) return NextResponse.json({ error: 'toCategoryReference required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()

    // The destination must belong to the caller's restaurant.
    const ownsTarget = (await sql`
      SELECT 1 FROM disco_menu_categories c
      JOIN disco_menus m ON m.reference = c.menu_reference
      WHERE c.reference = ${toCat}::uuid AND m.restaurant_reference = ${scope}::uuid LIMIT 1
    `) as unknown[]
    if (!ownsTarget.length) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

    // The item must belong to the caller's restaurant too, reached through the
    // category it is in NOW. Also gives us the source category, so the gap the
    // item leaves behind can be closed.
    const itemRows = (await sql`
      SELECT i.category_reference::text AS from_cat
      FROM disco_menu_items i
      JOIN disco_menu_categories c ON c.reference = i.category_reference
      JOIN disco_menus m ON m.reference = c.menu_reference
      WHERE i.reference = ${itemRef}::uuid AND m.restaurant_reference = ${scope}::uuid LIMIT 1
    `) as { from_cat: string }[]
    if (!itemRows.length) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    const fromCat = itemRows[0].from_cat

    if (fromCat === toCat) {
      // Not a move — fall through to a plain reorder so the client can use one
      // code path for a drag that happens to land back where it started.
      const refs = cleanRefs(body?.references)
      const moved = refs.length ? await applyOrder('disco_menu_items', toCat, refs) : 0
      return NextResponse.json({ success: true, moved: false, reordered: moved })
    }

    // THE MOVE. One statement, scoped by the item's current category so a
    // concurrent move cannot double-apply.
    const updated = (await sql`
      UPDATE disco_menu_items
      SET category_reference = ${toCat}::uuid, updated_at = NOW()
      WHERE reference = ${itemRef}::uuid AND category_reference = ${fromCat}::uuid
      RETURNING reference
    `) as { reference: string }[]
    if (!updated.length) return NextResponse.json({ error: 'Item moved already' }, { status: 409 })

    // Position inside the destination. `references` already includes the moved
    // item, so this is the ordinary reorder applied to the new membership.
    const refs = cleanRefs(body?.references)
    const placed = refs.length ? await applyOrder('disco_menu_items', toCat, refs) : 0

    // Close the gap in the source category. Without this the remaining items
    // keep positions 0,1,3,4… — harmless for display order, but it compounds
    // over repeated moves until the numbers say nothing about the sequence.
    const remaining = (await sql`
      SELECT reference::text AS reference FROM disco_menu_items
      WHERE category_reference = ${fromCat}::uuid
      ORDER BY position, created_at
    `) as { reference: string }[]
    if (remaining.length) await applyOrder('disco_menu_items', fromCat, remaining.map(r => r.reference))

    return NextResponse.json({
      success: true, moved: true, fromCategoryReference: fromCat,
      toCategoryReference: toCat, placed, resequenced: remaining.length,
    })
  } catch (e) {
    console.error('[disco-menu-items/move] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to move the item' }, { status: 500 })
  }
}
