import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// Disco-native MODIFIERS (FM addOn): a named option with a price, reused across
// modifier groups. Restaurant-scoped (SA → selected location via resolveDiscoScopeRef).
//   GET  ?includeArchived=1 → list; POST → create { name, price }
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const includeArchived = req.nextUrl.searchParams.get('includeArchived') === '1'
  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      SELECT reference, name, price, archived, visible, position
      FROM disco_modifiers
      WHERE restaurant_reference = ${ref}::uuid AND (${includeArchived} OR archived = false)
      ORDER BY position, name
    `) as Record<string, unknown>[]
    return NextResponse.json({ modifiers: rows })
  } catch (e) {
    console.error('[disco-modifiers] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load modifiers' }, { status: 500 })
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
  if (!name) return NextResponse.json({ error: 'Modifier name is required.' }, { status: 400 })
  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      INSERT INTO disco_modifiers (restaurant_reference, name, price, position)
      VALUES (${ref}::uuid, ${name}, ${num(body?.price)},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_modifiers WHERE restaurant_reference = ${ref}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: rows[0]?.reference })
  } catch (e) {
    console.error('[disco-modifiers] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create modifier' }, { status: 500 })
  }
}
