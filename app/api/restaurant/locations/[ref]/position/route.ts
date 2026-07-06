import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { discoGroupRefs } from '../../../../../../lib/disco-restaurant-auth'
import { sql, runMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Reorder a system-admin restaurant "location". This matches FM's own
// locations page exactly: restaurant.service.ts:200 updatePosition() →
// PUT /api/system-admin/restaurants/{ref}/position?position=N with a null body.
// (There is no addresses/{ref}/position endpoint — FM models each location as a
// system-admin restaurant entity, reordered by this call.)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const position = req.nextUrl.searchParams.get('position') || '0'

  // Disco-native: reorder within the SA's group. Pull the current order, move this
  // location to the target index, and renumber location_position across the group.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const refs = await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)
    if (!refs.has(ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    try {
      await runMigrations()
      const refArr = [...refs]
      const ordered = (await sql`
        SELECT restaurant_reference AS ref FROM disco_restaurant_cache
        WHERE restaurant_reference = ANY(${refArr}::text[])
        ORDER BY COALESCE(location_position, 999999) ASC, name ASC
      `) as { ref: string }[]
      const list = ordered.map(o => o.ref).filter(x => x !== ref)
      const target = Math.max(0, Math.min(Number(position) || 0, list.length))
      list.splice(target, 0, ref)
      for (let i = 0; i < list.length; i++) {
        await sql`UPDATE disco_restaurant_cache SET location_position = ${i} WHERE restaurant_reference = ${list[i]}`
      }
      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[locations/position] disco reorder failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update position' }, { status: 500 })
    }
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}/position?position=${position}`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update position' }, { status: 500 }) }
}
