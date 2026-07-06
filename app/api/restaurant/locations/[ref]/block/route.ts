import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../../../lib/db'
import { discoGroupRefs } from '../../../../../../lib/disco-restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const blocked = req.nextUrl.searchParams.get('blocked') || 'false'

  // Disco-native: block/unblock a location = remove/show it on the marketplace
  // (is_live). Scoped to the SA's group.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!(await discoGroupRefs(ctx.businessName, ctx.email, ctx.restaurantReference)).has(ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    await runMigrations()
    await sql`UPDATE disco_restaurant_cache SET is_live = ${blocked !== 'true'}, cached_at = NOW() WHERE restaurant_reference = ${ref}`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}/block?blocked=${blocked}`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}
