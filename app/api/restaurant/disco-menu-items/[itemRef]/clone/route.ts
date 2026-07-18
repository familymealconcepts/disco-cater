import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
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
  const scopeRef = await resolveDiscoScopeRef(ctx)
  await runDiscoMenuMigrations()
  // Copy EVERY field, including the Stage-8 fields (display_price, min_quantity,
  // allow_special_instructions, dietary flags) — not just the basics.
  const rows = (await sql`
    SELECT category_reference, name, description, price, serves, image_url, visible,
           display_price, min_quantity, allow_special_instructions,
           vegetarian, contains_nuts, gluten_free, vegan
    FROM disco_menu_items
    WHERE reference = ${itemRef}::uuid AND restaurant_reference = ${scopeRef}::uuid LIMIT 1
  `.catch(() => [])) as Record<string, unknown>[]
  const src = rows[0]
  if (!src) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  try {
    const out = (await sql`
      INSERT INTO disco_menu_items (
        restaurant_reference, category_reference, name, description, price, serves, image_url, visible,
        display_price, min_quantity, allow_special_instructions, vegetarian, contains_nuts, gluten_free, vegan, position)
      VALUES (
        ${scopeRef}::uuid, ${src.category_reference}::uuid, ${`${src.name} (Copy)`},
        ${src.description ?? null}, ${src.price ?? 0}, ${src.serves ?? null}, ${src.image_url ?? null}, ${src.visible ?? true},
        ${(src.display_price as string | null) ?? null}, ${(src.min_quantity as number | null) ?? null},
        ${src.allow_special_instructions ?? false}, ${src.vegetarian ?? false}, ${src.contains_nuts ?? false},
        ${src.gluten_free ?? false}, ${src.vegan ?? false},
        (SELECT COALESCE(MAX(position), -1) + 1 FROM disco_menu_items WHERE category_reference = ${src.category_reference}::uuid))
      RETURNING reference
    `) as { reference: string }[]
    const newRef = out[0]?.reference

    // Re-link the copy to the SAME modifier groups (attachments), preserving
    // enabled + position. Best-effort — the item copy already succeeded.
    if (newRef) {
      await sql`
        INSERT INTO disco_item_groups (item_reference, group_reference, enabled, position)
        SELECT ${newRef}::uuid, group_reference, enabled, position
        FROM disco_item_groups WHERE item_reference = ${itemRef}::uuid
        ON CONFLICT (item_reference, group_reference) DO NOTHING
      `.catch(e => console.error('[disco-menu-items/clone] group re-link failed:', e instanceof Error ? e.message : e))
    }

    return NextResponse.json({ reference: newRef })
  } catch (e) {
    console.error('[disco-menu-items/clone] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to duplicate item' }, { status: 500 })
  }
}
