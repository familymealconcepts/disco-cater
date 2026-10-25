// Menu Builder location picker: Disco-native restaurants only (a FamilyMeal-
// backed restaurant's menu lives in FamilyMeal, which the builder never writes).
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../lib/db'
import { requireMenuBuilderAccess } from '../../../../../lib/menu-builder/access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const menusFor = req.nextUrl.searchParams.get('menus')
  if (menusFor) {
    if (!/^[0-9a-f-]{36}$/i.test(menusFor)) return NextResponse.json({ error: 'bad ref' }, { status: 400 })
    const menus = await sql`
      SELECT reference::text AS reference, name, visible, archived, type, updated_at
        FROM disco_menus WHERE restaurant_reference = ${menusFor}::uuid ORDER BY archived ASC, position, name`
    return NextResponse.json({ menus })
  }
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  if (q.length < 2) return NextResponse.json({ restaurants: [] })
  const restaurants = await sql`
    SELECT restaurant_reference::text AS reference, name, city, state
      FROM disco_restaurant_cache
     WHERE is_disco_native = true AND archived_at IS NULL AND name ILIKE ${'%' + q + '%'}
     ORDER BY name LIMIT 30`
  return NextResponse.json({ restaurants })
}
