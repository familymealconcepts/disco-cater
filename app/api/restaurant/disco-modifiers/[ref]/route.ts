import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// The modifier's restaurant scope if it belongs to the caller's location, else null.
async function ownedRef(reqRef: string): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(reqRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT 1 FROM disco_modifiers WHERE reference = ${reqRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length ? scopeRef : null
}

// PUT — edit (name/price) and/or archive toggle. Archiving forces visible=false
// (mirrors FM); unarchiving leaves it visible.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedRef(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    // Archive-only toggle (fast path).
    if (typeof body?.archived === 'boolean' && body?.name === undefined) {
      if (body.archived) {
        await sql`UPDATE disco_modifiers SET archived = true, visible = false, updated_at = NOW() WHERE reference = ${ref}::uuid`
      } else {
        await sql`UPDATE disco_modifiers SET archived = false, visible = true, updated_at = NOW() WHERE reference = ${ref}::uuid`
      }
      return NextResponse.json({ ok: true })
    }
    const name = String(body?.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Modifier name is required.' }, { status: 400 })
    await sql`
      UPDATE disco_modifiers SET name = ${name}, price = ${num(body?.price)}, updated_at = NOW()
      WHERE reference = ${ref}::uuid
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-modifiers/[ref]] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update modifier' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedRef(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    await sql`DELETE FROM disco_modifiers WHERE reference = ${ref}::uuid`
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-modifiers/[ref]] DELETE failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to delete modifier' }, { status: 500 })
  }
}
