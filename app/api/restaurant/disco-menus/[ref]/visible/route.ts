import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Hide / Show a Disco-native menu in one click (Peter, 2026-11-24): the Menu Manager row button that matches FamilyMeal's menu
// screen, where Hide/Show sits next to Archive. Writes ONLY disco_menus.visible (Active <-> Inactive, lib/menu-state.ts), unlike the
// Menu Settings save, which sends the whole menu. The Visible checkbox in Menu Settings writes the same column and stays.
// An archived menu is left alone (it shows Restore instead, as FamilyMeal's Archived tab does). Scoped to the caller's
// restaurant, like unarchive; zero FM.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid menu reference' }, { status: 400 })
  const raw = req.nextUrl.searchParams.get('isVisible')
  if (raw !== 'true' && raw !== 'false') return NextResponse.json({ error: 'isVisible must be true or false' }, { status: 400 })
  const isVisible = raw === 'true'
  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      UPDATE disco_menus SET visible = ${isVisible}, updated_at = NOW()
      WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid AND archived = false
      RETURNING reference, visible
    `) as { reference: string; visible: boolean }[]
    if (!rows.length) return NextResponse.json({ error: 'Menu not found (or archived)' }, { status: 404 })
    return NextResponse.json({ success: true, visible: rows[0].visible })
  } catch (e) {
    console.error('[restaurant/disco-menus/[ref]/visible] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update menu' }, { status: 500 })
  }
}
