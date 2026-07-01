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
      SELECT include_utensils, image_url FROM disco_menu_settings WHERE menu_reference = ${menuRef}::uuid LIMIT 1
    `) as { include_utensils: boolean | null; image_url: string | null }[]
    return NextResponse.json({ includeUtensils: rows[0]?.include_utensils === true, imageUrl: rows[0]?.image_url || '' })
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
  // Partial update: only touch a field when its key is present in the body, so the
  // dialog (image) and the settings page (utensils) never clobber each other.
  const hasUtensils = Object.prototype.hasOwnProperty.call(body, 'includeUtensils')
  const hasImage = Object.prototype.hasOwnProperty.call(body, 'imageUrl')
  const includeUtensils = body?.includeUtensils === true
  const imageUrl = String(body?.imageUrl || '') || null
  try {
    await runMigrations()
    // Ensure the row exists, then update only the field(s) the caller sent — so the
    // dialog's image save and the settings page's utensils save never overwrite one
    // another.
    await sql`
      INSERT INTO disco_menu_settings (menu_reference, restaurant_reference, updated_at)
      VALUES (${menuRef}::uuid, ${ctx.restaurantReference || null}, NOW())
      ON CONFLICT (menu_reference) DO UPDATE
        SET restaurant_reference = COALESCE(${ctx.restaurantReference || null}, disco_menu_settings.restaurant_reference),
            updated_at = NOW()
    `
    if (hasUtensils) {
      await sql`UPDATE disco_menu_settings SET include_utensils = ${includeUtensils}, updated_at = NOW() WHERE menu_reference = ${menuRef}::uuid`
    }
    if (hasImage) {
      await sql`UPDATE disco_menu_settings SET image_url = ${imageUrl}, updated_at = NOW() WHERE menu_reference = ${menuRef}::uuid`
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[restaurant/menu-settings] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save menu settings' }, { status: 500 })
  }
}
