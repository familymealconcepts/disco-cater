import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../../../lib/db'
import { resolveDiscoGroupScope, discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const blocked = req.nextUrl.searchParams.get('blocked') || 'false'

  // Disco-native: this control means MAP — it removes or shows a location in the
  // marketplace. Scoped to the SA's group.
  //
  // It used to write disco_restaurant_cache.is_live, which is not one of the
  // three concepts and which the marketplace feed has never read, so the toggle
  // was INERT: a system admin could block a location and it stayed on the map.
  // It now writes the Map toggle itself (disco_restaurant_overrides.visible),
  // the same column the feed reads and the same one the super-admin marketplace
  // control writes.
  const ctx = await getRestaurantAuthContext()
  // KEYED ON THE LOCATION BEING ACTED ON, not on the session. `ref` is the
  // location in the URL, so its own native flag is the right discriminator —
  // a master-password FM session used to send a native location's change to
  // FamilyMeal, which does not own it.
  if (ctx && await isDiscoNativeRestaurant(ref)) {
    if (!discoRefAllowed(await resolveDiscoGroupScope(ctx), ref)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    await runMigrations()
    // Upsert, not UPDATE: a native location with no overrides row yet would
    // otherwise silently match zero rows and report success, which is the same
    // failure in a new disguise.
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${ref}, ${blocked !== 'true'}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = ${blocked !== 'true'}, updated_at = NOW()
    `
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
