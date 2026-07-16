import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Validate group selection rules (mirrors FM): min ≥ 0, 1 ≤ max ≤ 50, min ≤ max.
// min == max is VALID — it means the customer must select exactly that many.
export function validateGroupRules(min: number, max: number): string | null {
  if (!Number.isInteger(min) || min < 0) return 'Minimum must be 0 or more.'
  if (!Number.isInteger(max) || max < 1 || max > 50) return 'Maximum must be between 1 and 50.'
  if (min > max) return 'Minimum cannot be greater than maximum.'
  return null
}

// Attach the member modifiers to a list of groups (single extra query).
async function withMembers(groups: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!groups.length) return groups
  const refs = groups.map(g => g.reference as string)
  const members = (await sql`
    SELECT gm.group_reference, m.reference, m.name, m.price
    FROM disco_modifier_group_members gm
    JOIN disco_modifiers m ON m.reference = gm.modifier_reference
    WHERE gm.group_reference = ANY(${refs}) AND m.archived = false
    ORDER BY gm.position, m.name
  `) as { group_reference: string; reference: string; name: string; price: number }[]
  const byGroup = new Map<string, unknown[]>()
  for (const m of members) {
    const list = byGroup.get(m.group_reference) ?? []
    list.push({ reference: m.reference, name: m.name, price: m.price })
    byGroup.set(m.group_reference, list)
  }
  return groups.map(g => ({ ...g, modifiers: byGroup.get(g.reference as string) ?? [] }))
}

// Attach the menu items each group is used in (single extra query) — powers the
// "used in" hover on the Groups page (#17).
async function withItemUsage(groups: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (!groups.length) return groups
  const refs = groups.map(g => g.reference as string)
  const rows = (await sql`
    SELECT ig.group_reference, mi.name
    FROM disco_item_groups ig
    JOIN disco_menu_items mi ON mi.reference = ig.item_reference
    WHERE ig.group_reference = ANY(${refs})
    ORDER BY mi.name
  `) as { group_reference: string; name: string }[]
  const byGroup = new Map<string, string[]>()
  for (const r of rows) { const l = byGroup.get(r.group_reference) ?? []; l.push(r.name); byGroup.set(r.group_reference, l) }
  return groups.map(g => ({ ...g, itemsUsedIn: byGroup.get(g.reference as string) ?? [] }))
}

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1'
  try {
    await runDiscoMenuMigrations()
    const groups = (await sql`
      SELECT reference, name, external_name, sub_external_name, min_selected, max_selected, archived, visible, position
      FROM disco_modifier_groups
      WHERE restaurant_reference = ${ref}::uuid AND (${includeArchived} OR archived = false)
      ORDER BY position, name
    `) as Record<string, unknown>[]
    return NextResponse.json({ groups: await withItemUsage(await withMembers(groups)) })
  } catch (e) {
    console.error('[disco-modifier-groups] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load groups' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const name = String(body?.name || '').trim()
  if (!name) return NextResponse.json({ error: 'Group name is required.' }, { status: 400 })
  const min = Math.trunc(Number(body?.minSelected ?? 0))
  const max = Math.trunc(Number(body?.maxSelected ?? 1))
  const ruleErr = validateGroupRules(min, max)
  if (ruleErr) return NextResponse.json({ error: ruleErr }, { status: 400 })
  const modRefs = Array.isArray(body?.modifierReferences) ? (body.modifierReferences as unknown[]).map(String).filter(r => UUID_RE.test(r)) : []
  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, position)
      VALUES (${ref}::uuid, ${name}, ${String(body?.externalName || '') || null}, ${String(body?.subExternalName || '') || null}, ${min}, ${max},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    const groupRef = rows[0]?.reference
    // Attach members (only modifiers owned by this restaurant), preserving order.
    let pos = 0
    for (const mr of modRefs) {
      await sql`
        INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position)
        SELECT ${groupRef}::uuid, ${mr}::uuid, ${pos}
        WHERE EXISTS (SELECT 1 FROM disco_modifiers WHERE reference = ${mr}::uuid AND restaurant_reference = ${ref}::uuid)
        ON CONFLICT (group_reference, modifier_reference) DO NOTHING
      `
      pos++
    }
    return NextResponse.json({ reference: groupRef })
  } catch (e) {
    console.error('[disco-modifier-groups] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create group' }, { status: 500 })
  }
}
