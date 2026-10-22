import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// "+ Add Existing Item" — like FM: pick from the restaurant's OTHER items (not
// already in this category) and COPY them in (copies, not references).
//   GET  ?categoryRef=…  → items in this restaurant not already in that category
//   POST { categoryReference, itemReferences: [...] } → copy each into the category

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const categoryRef = req.nextUrl.searchParams.get('categoryRef') || ''
  if (!UUID_RE.test(categoryRef)) return NextResponse.json({ error: 'categoryRef required' }, { status: 400 })
  await runDiscoMenuMigrations()
  const items = (await sql`
    SELECT reference, name, description, price, serves, image_url
    FROM disco_menu_items
    WHERE restaurant_reference = ${scopeRef}::uuid AND category_reference <> ${categoryRef}::uuid
    ORDER BY name
  `) as Record<string, unknown>[]
  // ── EACH ITEM'S MODIFIER GROUPS, SO THE DIALOG CAN PRE-SELECT THEM ────────
  // The copy used to carry none at all, so an item added this way arrived
  // stripped of its options and had to be rebuilt by hand. The dialog now
  // shows them ticked and the person unticks what they do not want.
  const refs = items.map(i => String(i.reference))
  const groups = refs.length ? (await sql`
    SELECT ig.item_reference::text AS item_reference, g.reference::text AS reference,
           g.name, g.external_name, ig.enabled, ig.position
      FROM disco_item_groups ig
      JOIN disco_modifier_groups g ON g.reference = ig.group_reference
     WHERE ig.item_reference::text = ANY(${refs})
       AND g.archived = false
     ORDER BY ig.position, g.name
  `.catch(() => [])) as Record<string, unknown>[] : []
  return NextResponse.json({ items, groups })
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const categoryReference = String(body?.categoryReference || '')
  const refs = Array.isArray(body?.itemReferences) ? (body.itemReferences as unknown[]).map(String).filter(r => UUID_RE.test(r)) : []
  // { sourceItemReference: [groupReference, ...] } — the groups the person left
  // ticked. Absent means "carry them all", so an older client that does not
  // send the map still gets the item's own groups rather than none.
  const rawGroups = (body?.groupsByItem && typeof body.groupsByItem === 'object' && !Array.isArray(body.groupsByItem))
    ? body.groupsByItem as Record<string, unknown> : null
  if (!UUID_RE.test(categoryReference)) return NextResponse.json({ error: 'categoryReference required' }, { status: 400 })
  if (refs.length === 0) return NextResponse.json({ error: 'Select at least one item.' }, { status: 400 })
  await runDiscoMenuMigrations()
  const owns = (await sql`
    SELECT 1 FROM disco_menu_categories WHERE reference = ${categoryReference}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  if (!owns.length) return NextResponse.json({ error: 'Category not found' }, { status: 404 })
  try {
    let copied = 0
    for (const r of refs) {
      // COPY (FM semantics) — restaurant-scoped source, appended to the category.
      const res = (await sql`
        INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, image_url, visible, position)
        SELECT ${scopeRef}::uuid, ${categoryReference}::uuid, name, description, price, serves, image_url, visible,
               (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_items WHERE category_reference = ${categoryReference}::uuid)
        FROM disco_menu_items
        WHERE reference = ${r}::uuid AND restaurant_reference = ${scopeRef}::uuid
        RETURNING reference
      `) as { reference: string }[]
      if (res.length) copied++
      // ── CARRY THE MODIFIER GROUPS ONTO THE COPY ──────────────────────────
      // Scoped to the source item's OWN groups, so a crafted payload cannot
      // attach a group the item never had. enabled/position are copied from
      // the source row rather than defaulted, so the copy behaves like the
      // original rather than merely resembling it.
      const newRef = res[0]?.reference
      if (newRef) {
        const wanted = rawGroups && Array.isArray(rawGroups[r])
          ? (rawGroups[r] as unknown[]).map(String).filter(g => UUID_RE.test(g))
          : null
        await sql`
          INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position)
          SELECT ${newRef}::uuid, ig.group_reference, ig.enabled, ig.position
            FROM disco_item_groups ig
            JOIN disco_modifier_groups g ON g.reference = ig.group_reference
           WHERE ig.item_reference = ${r}::uuid
             AND g.restaurant_reference = ${scopeRef}::uuid
             AND (${wanted === null} OR ig.group_reference::text = ANY(${wanted ?? []}::text[]))
        `.catch(e => console.error('[add-existing] group copy failed:', e instanceof Error ? e.message : e))
      }
    }
    return NextResponse.json({ copied })
  } catch (e) {
    console.error('[disco-menu-items/add-existing] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to add items' }, { status: 500 })
  }
}
