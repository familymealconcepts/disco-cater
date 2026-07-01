import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

// Per-menu Disco-only settings (currently just the "Include Utensils" toggle),
// stored in Neon keyed by the menu reference. FM has no utensils concept, so this
// never touches FM. GET ?menuRef=…; PUT { menuRef, includeUtensils }.

export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const menuRef = req.nextUrl.searchParams.get('menuRef') || ''
  if (!menuRef) return NextResponse.json({ error: 'menuRef required' }, { status: 400 })
  try {
    await runMigrations()
    const rows = (await sql`
      SELECT include_utensils FROM disco_menu_settings WHERE menu_reference = ${menuRef}::uuid LIMIT 1
    `) as { include_utensils: boolean | null }[]
    return NextResponse.json({ includeUtensils: rows[0]?.include_utensils === true })
  } catch (e) {
    console.error('[restaurant/menu-settings] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load menu settings' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const menuRef = String(body?.menuRef || '').trim()
  if (!menuRef) return NextResponse.json({ error: 'menuRef required' }, { status: 400 })
  const includeUtensils = body?.includeUtensils === true
  try {
    await runMigrations()
    await sql`
      INSERT INTO disco_menu_settings (menu_reference, restaurant_reference, include_utensils, updated_at)
      VALUES (${menuRef}::uuid, ${ctx.restaurantReference || null}, ${includeUtensils}, NOW())
      ON CONFLICT (menu_reference) DO UPDATE
        SET include_utensils = ${includeUtensils},
            restaurant_reference = COALESCE(${ctx.restaurantReference || null}, disco_menu_settings.restaurant_reference),
            updated_at = NOW()
    `
    return NextResponse.json({ includeUtensils })
  } catch (e) {
    console.error('[restaurant/menu-settings] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save menu settings' }, { status: 500 })
  }
}
