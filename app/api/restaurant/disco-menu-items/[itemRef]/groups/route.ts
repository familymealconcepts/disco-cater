import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The scope ref if the item belongs to the caller's location, else null.
async function ownedItemScope(itemRef: string): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(itemRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT 1 FROM disco_menu_items WHERE reference = ${itemRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length ? scopeRef : null
}

// GET — the item's attached modifier groups (ordered), each with its enabled flag,
// selection rules, and member modifiers. This is the shape the item editor and the
// customer ordering flow both consume.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ itemRef: string }> }) {
  const { itemRef } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedItemScope(itemRef))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const groups = (await sql`
    SELECT g.reference, g.name, g.external_name, g.sub_external_name, g.min_selected, g.max_selected,
           ig.enabled, ig.position
    FROM disco_item_groups ig
    JOIN disco_modifier_groups g ON g.reference = ig.group_reference AND g.archived = false
    WHERE ig.item_reference = ${itemRef}::uuid
    ORDER BY ig.position, g.name
  `) as Record<string, unknown>[]
  // Attach member modifiers.
  const refs = groups.map(g => g.reference as string)
  const members = refs.length ? (await sql`
    SELECT gm.group_reference, m.reference, m.name, m.price
    FROM disco_modifier_group_members gm
    JOIN disco_modifiers m ON m.reference = gm.modifier_reference AND m.archived = false
    WHERE gm.group_reference = ANY(${refs})
    ORDER BY gm.position, m.name
  `) as { group_reference: string; reference: string; name: string; price: number }[] : []
  const byGroup = new Map<string, unknown[]>()
  for (const m of members) { const l = byGroup.get(m.group_reference) ?? []; l.push({ reference: m.reference, name: m.name, price: m.price }); byGroup.set(m.group_reference, l) }
  return NextResponse.json({ groups: groups.map(g => ({ ...g, modifiers: byGroup.get(g.reference as string) ?? [] })) })
}

// PUT — replace the item's attached groups. Body: { groups: [{ reference, enabled }] }
// in display order. Only groups owned by the restaurant are attached.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ itemRef: string }> }) {
  const { itemRef } = await params
  await runDiscoMenuMigrations()
  const scopeRef = await ownedItemScope(itemRef)
  if (!scopeRef) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const list = Array.isArray(body?.groups) ? (body.groups as Record<string, unknown>[]) : []
  // De-duplicate on the way in: the same group twice would make ON CONFLICT
  // update a row the same statement is also inserting, which Postgres rejects
  // ("cannot affect row a second time").
  const refs: string[] = []
  const enabled: boolean[] = []
  const seen = new Set<string>()
  for (const g of list) {
    const gr = String(g?.reference || '')
    if (!UUID_RE.test(gr) || seen.has(gr)) continue
    seen.add(gr); refs.push(gr); enabled.push(g?.enabled !== false)
  }
  try {
    // ONE STATEMENT. This used to DELETE every row for the item and then INSERT
    // them back in a loop — and there are no transactions here, so a failure
    // after the DELETE left the item with ZERO modifier groups. That is a
    // customer-facing loss: disco_item_groups is what the storefront reads, so
    // the item silently loses every option a diner could pick.
    //
    // A data-modifying CTE does the whole swap atomically: `valid` applies the
    // same ownership check as before, `removed` deletes ONLY the groups that are
    // not in the new set, and the INSERT upserts the rest. Groups that survive
    // an edit are updated in place rather than destroyed and re-created.
    //
    // NOT EXISTS rather than NOT IN — NOT IN against a set containing NULL
    // matches nothing and would silently delete none of them.
    //
    // The empty case (detach everything) still works: Postgres runs a
    // data-modifying CTE exactly once and to completion whether or not the
    // primary query reads its output, so `removed` fires even when the INSERT
    // has no rows.
    await sql`
      WITH desired AS (
        SELECT ref, en, ord
        FROM unnest(${refs}::uuid[], ${enabled}::boolean[]) WITH ORDINALITY AS t(ref, en, ord)
      ),
      valid AS (
        SELECT d.* FROM desired d
        JOIN disco_modifier_groups g
          ON g.reference = d.ref AND g.restaurant_reference = ${scopeRef}::uuid
      ),
      removed AS (
        DELETE FROM disco_item_groups x
        WHERE x.item_reference = ${itemRef}::uuid
          AND NOT EXISTS (SELECT 1 FROM valid v WHERE v.ref = x.group_reference)
        RETURNING x.group_reference
      )
      INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position)
      SELECT ${itemRef}::uuid, v.ref, v.en, v.ord - 1 FROM valid v
      ON CONFLICT (item_reference, group_reference)
      DO UPDATE SET enabled = EXCLUDED.enabled, position = EXCLUDED.position
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-menu-items/[itemRef]/groups] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update item groups' }, { status: 500 })
  }
}
