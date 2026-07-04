import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Load the category if it belongs to the authed restaurant. Returns row or null.
async function ownedCategory(catRef: string): Promise<{ menu_reference: string } | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(catRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT menu_reference FROM disco_menu_categories
    WHERE reference = ${catRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as { menu_reference: string }[]
  return rows[0] ?? null
}

// PUT — rename/description, OR reorder (body.position = new index). FM reorders a
// single item and recomputes the rest; we mirror that server-side.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ catRef: string }> }) {
  const { catRef } = await params
  await runDiscoMenuMigrations()
  const cat = await ownedCategory(catRef)
  if (!cat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    if (typeof body?.position === 'number') {
      // Reorder within the menu: pull ordered refs, move this one to the target
      // index, write back sequential positions.
      const ordered = (await sql`
        SELECT reference FROM disco_menu_categories WHERE menu_reference = ${cat.menu_reference}::uuid ORDER BY position, name
      `) as { reference: string }[]
      const refs = ordered.map(r => r.reference).filter(r => r !== catRef)
      const target = Math.max(0, Math.min(Math.trunc(body.position as number), refs.length))
      refs.splice(target, 0, catRef)
      for (let i = 0; i < refs.length; i++) {
        await sql`UPDATE disco_menu_categories SET position = ${i}, updated_at = NOW() WHERE reference = ${refs[i]}::uuid`
      }
      return NextResponse.json({ ok: true })
    }
    // Visibility-only toggle (fast path).
    if (typeof body?.visible === 'boolean' && body?.name === undefined) {
      await sql`UPDATE disco_menu_categories SET visible = ${body.visible}, updated_at = NOW() WHERE reference = ${catRef}::uuid`
      return NextResponse.json({ ok: true })
    }
    const name = String(body?.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Category name is required.' }, { status: 400 })
    await sql`
      UPDATE disco_menu_categories SET name = ${name}, description = ${String(body?.description || '') || null},
        visible = ${body?.visible === false ? false : true}, updated_at = NOW()
      WHERE reference = ${catRef}::uuid
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-menu-categories] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update category' }, { status: 500 })
  }
}

// DELETE — blocked when the category still has items (mirrors FM).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ catRef: string }> }) {
  const { catRef } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedCategory(catRef))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const cnt = (await sql`SELECT COUNT(*)::int AS n FROM disco_menu_items WHERE category_reference = ${catRef}::uuid`) as { n: number }[]
  if ((cnt[0]?.n ?? 0) > 0) {
    return NextResponse.json({ error: 'Remove or move this category’s items before deleting it.' }, { status: 409 })
  }
  await sql`DELETE FROM disco_menu_categories WHERE reference = ${catRef}::uuid`
  return NextResponse.json({ ok: true })
}
