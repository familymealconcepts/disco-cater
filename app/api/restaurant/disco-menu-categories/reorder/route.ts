import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'
import { applyOrder, cleanRefs, UUID_RE } from '../../../../../lib/reorder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Reorder the categories of one menu. Body { menuReference, references[] }.
// Category order IS customer-facing: the storefront reads
// disco_menu_categories ORDER BY position (shared.tsx native loader).
//
// The menu is verified to belong to the caller's restaurant first; applyOrder
// then scopes every row to that menu, so a foreign category reference in the
// list is a no-op rather than a cross-tenant write.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: { menuReference?: unknown; references?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const menuRef = String(body?.menuReference ?? '')
  if (!UUID_RE.test(menuRef)) return NextResponse.json({ error: 'menuReference required' }, { status: 400 })
  const refs = cleanRefs(body?.references)
  if (!refs.length) return NextResponse.json({ error: 'references (ordered list) required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    const owns = (await sql`
      SELECT 1 FROM disco_menus WHERE reference = ${menuRef}::uuid AND restaurant_reference = ${scope}::uuid LIMIT 1
    `) as unknown[]
    if (!owns.length) return NextResponse.json({ error: 'Menu not found' }, { status: 404 })
    const moved = await applyOrder('disco_menu_categories', menuRef, refs)
    return NextResponse.json({ success: true, requested: refs.length, moved })
  } catch (e) {
    console.error('[disco-menu-categories/reorder] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to reorder categories' }, { status: 500 })
  }
}
