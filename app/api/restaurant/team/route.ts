import { NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'
import { getLocationAccessRefs } from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/restaurant/team
// Team page data for a Primary System Admin (PSA): the locations they can access
// (Section 1) and the Sub System Admins they created (Section 2). Disco-native
// SYSTEM_ADMIN sessions only.
export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (ctx.authType !== 'disco' || (ctx.role !== 'SYSTEM_ADMIN' && ctx.role !== 'SUPER_ADMIN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    await runDiscoOrderMigrations()

    // Section 1 — locations the PSA can access (name + address + live status).
    let refs = await getLocationAccessRefs(ctx.email)
    if (!refs.length && ctx.restaurantReference) refs = [ctx.restaurantReference]
    const locations = refs.length
      ? (await sql`
          SELECT restaurant_reference AS reference,
                 COALESCE(name, '') AS name,
                 COALESCE(address, '') AS address,
                 COALESCE(is_live, false) AS is_live
          FROM disco_restaurant_cache
          WHERE restaurant_reference = ANY(${refs}::text[])
          ORDER BY name ASC
        `) as Array<{ reference: string; name: string; address: string; is_live: boolean }>
      : []
    // Keep references that have no cache row so the PSA still sees them.
    const seen = new Set(locations.map(l => l.reference))
    const locationList = [
      ...locations.map(l => ({ reference: l.reference, name: l.name, address: l.address, isLive: l.is_live === true, isHome: l.reference === ctx.restaurantReference })),
      ...refs.filter(r => !seen.has(r)).map(r => ({ reference: r, name: '', address: '', isLive: false, isHome: r === ctx.restaurantReference })),
    ]

    // Section 2 — Sub System Admins created by this PSA.
    const subRows = (await sql`
      SELECT email, first_name, last_name, restaurant_reference
      FROM disco_restaurant_accounts
      WHERE created_by = ${ctx.email} AND role = 'SYSTEM_ADMIN'
      ORDER BY id ASC
    `) as Array<{ email: string; first_name: string | null; last_name: string | null; restaurant_reference: string | null }>

    const subAdmins = []
    for (const s of subRows) {
      const access = (await sql`
        SELECT la.restaurant_reference AS reference, COALESCE(c.name, '') AS name
        FROM disco_restaurant_location_access la
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = la.restaurant_reference
        WHERE la.account_email = ${s.email}
        ORDER BY la.id ASC
      `) as Array<{ reference: string; name: string }>
      subAdmins.push({
        email: s.email,
        firstName: s.first_name || '',
        lastName: s.last_name || '',
        locations: access.map(a => ({ reference: a.reference, name: a.name })),
      })
    }

    return NextResponse.json({ locations: locationList, subAdmins })
  } catch (err) {
    console.error('[restaurant/team] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to load team' }, { status: 500 })
  }
}
