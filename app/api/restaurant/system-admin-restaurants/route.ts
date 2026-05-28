import { NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

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
