import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { parseItemFields } from '../../../../../lib/menu-settings'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

async function ownedItem(itemRef: string): Promise<{ category_reference: string } | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(itemRef)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT category_reference FROM disco_menu_items
    WHERE reference = ${itemRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as { category_reference: string }[]
  return rows[0] ?? null
}

// PUT — edit fields, toggle `visible` (OFF hides from customers), or reorder
// within the category (body.position = new index).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ itemRef: string }> }) {
  const { itemRef } = await params
  await runDiscoMenuMigrations()
  const item = await ownedItem(itemRef)
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    // Reorder within the category.
    if (typeof body?.position === 'number') {
      const ordered = (await sql`
        SELECT reference FROM disco_menu_items WHERE category_reference = ${item.category_reference}::uuid ORDER BY position, name
      `) as { reference: string }[]
      const refs = ordered.map(r => r.reference).filter(r => r !== itemRef)
      const target = Math.max(0, Math.min(Math.trunc(body.position as number), refs.length))
      refs.splice(target, 0, itemRef)
      for (let i = 0; i < refs.length; i++) {
        await sql`UPDATE disco_menu_items SET position = ${i}, updated_at = NOW() WHERE reference = ${refs[i]}::uuid`
      }
      return NextResponse.json({ ok: true })
    }
    // Visible-only toggle (fast path).
    if (Object.keys(body).length === 1 && typeof body?.visible === 'boolean') {
      await sql`UPDATE disco_menu_items SET visible = ${body.visible}, updated_at = NOW() WHERE reference = ${itemRef}::uuid`
      return NextResponse.json({ ok: true })
    }
    // Full edit.
    const name = String(body?.name ?? '').trim()
    if (!name) return NextResponse.json({ error: 'Item name is required.' }, { status: 400 })
    const f = parseItemFields(body)
    await sql`
      UPDATE disco_menu_items SET
        name = ${name}, description = ${String(body?.description || '') || null},
        price = ${num(body?.price)}, serves = ${String(body?.serves || '') || null},
        image_url = COALESCE(${String(body?.imageUrl || '') || null}, image_url),
        visible = ${body?.visible === false ? false : true},
        display_price = ${f.displayPrice}, min_quantity = ${f.minQuantity},
        allow_special_instructions = ${f.allowSpecialInstructions},
        vegetarian = ${f.vegetarian}, contains_nuts = ${f.containsNuts},
        gluten_free = ${f.glutenFree}, vegan = ${f.vegan},
        updated_at = NOW()
      WHERE reference = ${itemRef}::uuid
    `
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[disco-menu-items/[itemRef]] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update item' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ itemRef: string }> }) {
  const { itemRef } = await params
  await runDiscoMenuMigrations()
  if (!(await ownedItem(itemRef))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await sql`DELETE FROM disco_menu_items WHERE reference = ${itemRef}::uuid`
  return NextResponse.json({ ok: true })
}
