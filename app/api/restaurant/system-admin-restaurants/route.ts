import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getDiscoGroupAccounts } from '../../../../lib/disco-restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Mirrors FM restaurantService.getSystemAdminRestaurants() — flat list
// of the locations the JWT-identified SYSTEM_ADMIN has access to. FM's
// backend filters by JWT claim; this client never sees other locations.
//
// FM source: _system/_services/restaurant/restaurant.service.ts:31,
// 396-408. Used by admin-manager/authorized-users/update-authorized-
// users/update-authorized-users.component.ts:66 to populate the
// location picker on the Create / Edit user dialog.
//
// Response shape: array of { reference, businessName, editable }.
// Not paginated.
export async function GET() {
  // Disco-native sessions have no FM token — resolve their location list from
  // Neon. A Disco SYSTEM_ADMIN sees every location in their group; a Disco
  // ADMIN sees only their own (mirrors the FM-side per-role filtering).
  //
  // READ-PATH GAP (deliberately deferred, not fixed): a disco-native
  // SUPER_ADMIN's location-switcher list here is still their own group, not
  // literally every restaurant — a true "pick any restaurant" picker would
  // need a real list-all query, not built. With no group and no home ref this
  // returns an empty list (never an error, never another owner's locations).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    try {
      const isSA = ctx.role === 'SYSTEM_ADMIN' || ctx.role === 'SUPER_ADMIN'
      const group = isSA ? await getDiscoGroupAccounts(ctx.businessName, ctx.email) : []
      // De-duped by reference. getDiscoGroupAccounts used to return one row per
      // (grant x account row) and this was the only surface that showed the
      // duplicates to a human — kjp@atlantabread.com's dropdown listed Asheville
      // 9 times. The resolver is fixed, but this list is built from a set either
      // way so a future regression there can't reach the UI.
      const seen = new Set<string>()
      const list = (isSA ? group : []).reduce<{ reference: string; businessName: string; editable: boolean }[]>((acc, a) => {
        const ref = a.restaurant_reference
        if (!ref || seen.has(ref)) return acc
        seen.add(ref)
        acc.push({ reference: ref, businessName: a.restaurant_name || a.business_name || '', editable: true })
        return acc
      }, [])
      // Always include the user's own location (covers an ADMIN, or an SA whose
      // own row didn't come back from the group query).
      if (ctx.restaurantReference && !list.some(l => l.reference === ctx.restaurantReference)) {
        list.unshift({ reference: ctx.restaurantReference, businessName: ctx.restaurantName || '', editable: true })
      }
      return NextResponse.json(list)
    } catch (err) {
      console.error('[system-admin-restaurants] disco branch failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Unable to fetch locations' }, { status: 500 })
    }
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/list`, { headers: h })
    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to fetch locations', status: res.status }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch locations' }, { status: 500 })
  }
}
