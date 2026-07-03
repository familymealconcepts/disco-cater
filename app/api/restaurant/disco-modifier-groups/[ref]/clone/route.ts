import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Duplicate a group (name + " (Copy)") and its membership.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  await runDiscoMenuMigrations()
  const rows = (await sql`
    SELECT name, external_name, sub_external_name, min_selected, max_selected
    FROM disco_modifier_groups WHERE reference = ${ref}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as Record<string, unknown>[]
  const src = rows[0]
  if (!src) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const out = (await sql`
      INSERT INTO disco_modifier_groups (restaurant_reference, name, external_name, sub_external_name, min_selected, max_selected, position)
      VALUES (${scopeRef}::uuid, ${`${src.name} (Copy)`}, ${src.external_name ?? null}, ${src.sub_external_name ?? null}, ${src.min_selected ?? 0}, ${src.max_selected ?? 1},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_modifier_groups WHERE restaurant_reference = ${scopeRef}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    const newRef = out[0]?.reference
    // Copy membership, preserving order.
    await sql`
      INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position)
      SELECT ${newRef}::uuid, modifier_reference, position FROM disco_modifier_group_members WHERE group_reference = ${ref}::uuid
      ON CONFLICT (group_reference, modifier_reference) DO NOTHING
    `
    return NextResponse.json({ reference: newRef })
  } catch (e) {
    console.error('[disco-modifier-groups/clone] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to duplicate group' }, { status: 500 })
  }
}
