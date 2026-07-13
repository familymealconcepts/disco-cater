import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../lib/db'

// Public read of a menu's "Include Utensils" toggle, so the customer ordering
// page can decide whether to offer the optional utensils checkbox at checkout.
// Non-sensitive boolean; no auth. GET ?menuRef=…  → { includeUtensils }.
export async function GET(req: NextRequest) {
  const menuRef = req.nextUrl.searchParams.get('menuRef') || ''
  if (!menuRef) return NextResponse.json({ includeUtensils: false })
  try {
    await runMigrations()
    // include_utensils is stored on disco_menus (written by the menu-settings save
    // in /api/restaurant/disco-menus). The old query read disco_menu_settings — a
    // table that's never populated — so the checkout checkbox never appeared even
    // when the restaurant had enabled it.
    const rows = (await sql`
      SELECT include_utensils FROM disco_menus WHERE reference = ${menuRef}::uuid LIMIT 1
    `.catch(() => [])) as { include_utensils: boolean | null }[]
    return NextResponse.json({ includeUtensils: rows[0]?.include_utensils === true })
  } catch {
    return NextResponse.json({ includeUtensils: false })
  }
}
