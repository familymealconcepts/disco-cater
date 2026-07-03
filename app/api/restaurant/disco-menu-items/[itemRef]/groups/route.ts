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
  try {
    await sql`DELETE FROM disco_item_groups WHERE item_reference = ${itemRef}::uuid`
    let pos = 0
    for (const g of list) {
      const gr = String(g?.reference || '')
      if (!UUID_RE.test(gr)) continue
      const enabled = g?.enabled !== false
      await sql`
        INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position)
        SELECT ${itemRef}::uuid, ${gr}::uuid, ${enabled}, ${pos}
        WHERE EXISTS (SELECT 1 FROM disco_modifier_groups WHERE reference = ${gr}::uuid AND restaurant_reference = ${scopeRef}::uuid)
        ON CONFLICT (item_reference, group_reference) DO UPDATE SET enabled = EXCLUDED.enabled, position = EXCLUDED.position
      `
      pos++
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-menu-items/[itemRef]/groups] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update item groups' }, { status: 500 })
  }
}
