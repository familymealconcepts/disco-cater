import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'
import { validateGroupRules } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function ownedRef(reqRef: string): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(reqRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT 1 FROM disco_modifier_groups WHERE reference = ${reqRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length ? scopeRef : null
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  const restRef = await ownedRef(ref)
  if (!restRef) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    // Archive-only toggle.
    if (typeof body?.archived === 'boolean' && body?.name === undefined) {
      await sql`UPDATE disco_modifier_groups SET archived = ${body.archived}, visible = ${!body.archived}, updated_at = NOW() WHERE reference = ${ref}::uuid`
      return NextResponse.json({ ok: true })
    }
    const name = String(body?.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Group name is required.' }, { status: 400 })
    const min = Math.trunc(Number(body?.minSelected ?? 0))
    const max = Math.trunc(Number(body?.maxSelected ?? 1))
    const ruleErr = validateGroupRules(min, max)
    if (ruleErr) return NextResponse.json({ error: ruleErr }, { status: 400 })

    await sql`
      UPDATE disco_modifier_groups SET
        name = ${name}, external_name = ${String(body?.externalName || '') || null},
        sub_external_name = ${String(body?.subExternalName || '') || null},
        min_selected = ${min}, max_selected = ${max}, updated_at = NOW()
      WHERE reference = ${ref}::uuid
    `
    // Replace membership when modifierReferences is provided (preserve order).
    if (Array.isArray(body?.modifierReferences)) {
      const modRefs = (body.modifierReferences as unknown[]).map(String).filter(r => UUID_RE.test(r))
      await sql`DELETE FROM disco_modifier_group_members WHERE group_reference = ${ref}::uuid`
      let pos = 0
      for (const mr of modRefs) {
        await sql`
          INSERT INTO disco_modifier_group_members (group_reference, modifier_reference, position)
          SELECT ${ref}::uuid, ${mr}::uuid, ${pos}
          WHERE EXISTS (SELECT 1 FROM disco_modifiers WHERE reference = ${mr}::uuid AND restaurant_reference = ${restRef}::uuid)
          ON CONFLICT (group_reference, modifier_reference) DO NOTHING
        `
        pos++
      }
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-modifier-groups/[ref]] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update group' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedRef(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    await sql`DELETE FROM disco_modifier_group_members WHERE group_reference = ${ref}::uuid`
    await sql`DELETE FROM disco_item_groups WHERE group_reference = ${ref}::uuid`
    await sql`DELETE FROM disco_modifier_groups WHERE reference = ${ref}::uuid`
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-modifier-groups/[ref]] DELETE failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to delete group' }, { status: 500 })
  }
}
