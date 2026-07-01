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
    const rows = (await sql`
      SELECT include_utensils FROM disco_menu_settings WHERE menu_reference = ${menuRef}::uuid LIMIT 1
    `.catch(() => [])) as { include_utensils: boolean | null }[]
    return NextResponse.json({ includeUtensils: rows[0]?.include_utensils === true })
  } catch {
    return NextResponse.json({ includeUtensils: false })
  }
}
