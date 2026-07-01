import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Duplicate an item within the same category (mirrors FM clone) — name + " (Copy)",
// placed at the end of the category.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ itemRef: string }> }) {
  const { itemRef } = await params
  const ctx = await getRestaurantAuthContext()
  if (!ctx?.restaurantReference || !UUID_RE.test(itemRef)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await runDiscoMenuMigrations()
  const rows = (await sql`
    SELECT category_reference, name, description, price, serves, image_url, visible
    FROM disco_menu_items
    WHERE reference = ${itemRef}::uuid AND restaurant_reference = ${ctx.restaurantReference}::uuid LIMIT 1
  `.catch(() => [])) as Record<string, unknown>[]
  const src = rows[0]
  if (!src) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const out = (await sql`
      INSERT INTO disco_menu_items (restaurant_reference, category_reference, name, description, price, serves, image_url, visible, position)
      VALUES (${ctx.restaurantReference}::uuid, ${src.category_reference}::uuid, ${`${src.name} (Copy)`},
              ${src.description ?? null}, ${src.price ?? 0}, ${src.serves ?? null}, ${src.image_url ?? null}, ${src.visible ?? true},
              (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_items WHERE category_reference = ${src.category_reference}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: out[0]?.reference })
  } catch (e) {
    console.error('[disco-menu-items/clone] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to duplicate item' }, { status: 500 })
  }
}
