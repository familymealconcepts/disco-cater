import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Duplicate a modifier within the same restaurant (mirrors FM clone) — name +
// " (Copy)", appended at the end.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  await runDiscoMenuMigrations()
  const rows = (await sql`
    SELECT name, price, visible FROM disco_modifiers
    WHERE reference = ${ref}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as Record<string, unknown>[]
  const src = rows[0]
  if (!src) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const out = (await sql`
      INSERT INTO disco_modifiers (restaurant_reference, name, price, visible, position)
      VALUES (${scopeRef}::uuid, ${`${src.name} (Copy)`}, ${src.price ?? 0}, ${src.visible ?? true},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_modifiers WHERE restaurant_reference = ${scopeRef}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: out[0]?.reference })
  } catch (e) {
    console.error('[disco-modifiers/clone] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to duplicate modifier' }, { status: 500 })
  }
}
