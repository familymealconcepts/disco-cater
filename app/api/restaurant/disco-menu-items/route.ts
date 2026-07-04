import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { parseItemFields } from '../../../../lib/menu-settings'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

// Create a menu item in a category the authed restaurant owns.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const categoryReference = String(body?.categoryReference || '')
  const name = String(body?.name || '').trim()
  if (!UUID_RE.test(categoryReference)) return NextResponse.json({ error: 'categoryReference is required.' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'Item name is required.' }, { status: 400 })
  await runDiscoMenuMigrations()
  const owns = (await sql`
    SELECT 1 FROM disco_menu_categories WHERE reference = ${categoryReference}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as unknown[]
  if (!owns.length) return NextResponse.json({ error: 'Category not found' }, { status: 404 })
  try {
    const f = parseItemFields(body)
    const rows = (await sql`
      INSERT INTO disco_menu_items (
        restaurant_reference, category_reference, name, description, price, serves, image_url, visible,
        display_price, min_quantity, allow_special_instructions, vegetarian, contains_nuts, gluten_free, vegan, position)
      VALUES (${scopeRef}::uuid, ${categoryReference}::uuid, ${name},
              ${String(body?.description || '') || null}, ${num(body?.price)}, ${String(body?.serves || '') || null},
              ${String(body?.imageUrl || '') || null}, ${body?.visible === false ? false : true},
              ${f.displayPrice}, ${f.minQuantity}, ${f.allowSpecialInstructions}, ${f.vegetarian}, ${f.containsNuts}, ${f.glutenFree}, ${f.vegan},
              (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_items WHERE category_reference = ${categoryReference}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: rows[0]?.reference })
  } catch (e) {
    console.error('[disco-menu-items] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create item' }, { status: 500 })
  }
}
