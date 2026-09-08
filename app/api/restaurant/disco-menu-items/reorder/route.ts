import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'
import { applyOrder, cleanRefs, UUID_RE } from '../../../../../lib/reorder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Reorder the items of one category. Body { categoryReference, references[] }.
// Items order WITHIN a category, not across the menu — the storefront groups by
// category and reads disco_menu_items ORDER BY position inside each.
//
// Ownership is checked through the category's menu, because a category has no
// restaurant_reference of its own.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: { categoryReference?: unknown; references?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const catRef = String(body?.categoryReference ?? '')
  if (!UUID_RE.test(catRef)) return NextResponse.json({ error: 'categoryReference required' }, { status: 400 })
  const refs = cleanRefs(body?.references)
  if (!refs.length) return NextResponse.json({ error: 'references (ordered list) required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    const owns = (await sql`
      SELECT 1 FROM disco_menu_categories c
      JOIN disco_menus m ON m.reference = c.menu_reference
      WHERE c.reference = ${catRef}::uuid AND m.restaurant_reference = ${scope}::uuid LIMIT 1
    `) as unknown[]
    if (!owns.length) return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    const moved = await applyOrder('disco_menu_items', catRef, refs)
    return NextResponse.json({ success: true, requested: refs.length, moved })
  } catch (e) {
    console.error('[disco-menu-items/reorder] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to reorder items' }, { status: 500 })
  }
}
