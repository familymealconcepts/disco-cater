import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Categories (+ their items) for one Disco-native menu. Menu-scoped via
// disco_menu_categories.menu_reference (FM ItemCategory is menu-scoped).
async function ownsMenu(ref: string): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(ref)) return null
  const scopeRef = await resolveDiscoScopeRef(ctx)
  const rows = (await sql`
    SELECT 1 FROM disco_menus WHERE reference = ${ref}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  return rows.length ? scopeRef : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  if (!(await ownsMenu(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const categories = (await sql`
    SELECT reference, name, description, position, visible
    FROM disco_menu_categories WHERE menu_reference = ${ref}::uuid
    ORDER BY position, name
  `) as Record<string, unknown>[]
  const items = (await sql`
    SELECT i.reference, i.category_reference, i.name, i.description, i.price, i.serves,
           i.visible, i.position, i.image_url,
           i.display_price, i.min_quantity, i.allow_special_instructions,
           i.vegetarian, i.contains_nuts, i.gluten_free, i.vegan
    FROM disco_menu_items i
    JOIN disco_menu_categories c ON c.reference = i.category_reference
    WHERE c.menu_reference = ${ref}::uuid
    ORDER BY i.position, i.name
  `) as Record<string, unknown>[]
  return NextResponse.json({ categories, items })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  await runDiscoMenuMigrations()
  const restRef = await ownsMenu(ref)
  if (!restRef) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const name = String(body?.name || '').trim()
  if (!name) return NextResponse.json({ error: 'Category name is required.' }, { status: 400 })
  try {
    const rows = (await sql`
      INSERT INTO disco_menu_categories (restaurant_reference, menu_reference, name, description, position)
      VALUES (${restRef}::uuid, ${ref}::uuid, ${name}, ${String(body?.description || '') || null},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_categories WHERE menu_reference = ${ref}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: rows[0]?.reference })
  } catch (e) {
    console.error('[disco-menus/categories] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create category' }, { status: 500 })
  }
}
