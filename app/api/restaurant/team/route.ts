import { NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'
import { getLocationAccessRefs } from '../../../../lib/disco-restaurant-auth'
import { resolveDiscoAccessScope } from '../../../../lib/restaurant-write-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/restaurant/team
// Team page data for a Primary System Admin (PSA): the locations they can access
// (Section 1) and the Sub System Admins they created (Section 2). Disco-native
// SYSTEM_ADMIN sessions only.
export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  // Any disco session manages a team: an SA over their group's locations, an ADMIN
  // over just their own restaurant (the queries below scope to what they can access
  // + the users they created).
  if (ctx.authType !== 'disco') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    await runDiscoOrderMigrations()

    // Section 1 — locations the caller can access (name + address + live status).
    //
    // ROLE GATES REACH (fixed 2026-09-01). This used to call
    // getLocationAccessRefs directly with no role branch, so an ADMIN carrying
    // drifted grant rows saw every one of them: verified, Stacy Freemyer
    // (role ADMIN, FM assigns her Woodstock alone) got the name, address and
    // live status of all 8 Atlanta Bread locations. resolveDiscoAccessScope
    // returns home-ref-only for any role that isn't SYSTEM_ADMIN.
    //
    // SUPER_ADMIN keeps exactly today's behaviour (their own explicit-access
    // rows, home-only if none) rather than becoming unrestricted — a true
    // "every restaurant" view needs a real list-all query; not built.
    const gate = await resolveDiscoAccessScope(ctx)
    let refs = gate.unrestricted ? await getLocationAccessRefs(ctx.email) : [...gate.refs]
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

    // Helper: the location names an account can access.
    const accessFor = async (email: string) => (await sql`
      SELECT la.restaurant_reference AS reference, COALESCE(c.name, '') AS name
      FROM disco_restaurant_location_access la
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = la.restaurant_reference
      WHERE la.account_email = ${email}
      ORDER BY la.id ASC
    `) as Array<{ reference: string; name: string }>

    // All users this account created — both SYSTEM_ADMIN and ADMIN (Restaurant
    // User) — for the unified Authorized Users table.
    const userRows = (await sql`
      SELECT email, first_name, last_name, role, invite_token, created_at::text AS created_at
      FROM disco_restaurant_accounts
      WHERE created_by = ${ctx.email}
      ORDER BY id ASC
    `) as Array<{ email: string; first_name: string | null; last_name: string | null; role: string | null; invite_token: string | null; created_at: string | null }>

    const users = []
    for (const u of userRows) {
      users.push({
        email: u.email,
        firstName: u.first_name || '',
        lastName: u.last_name || '',
        role: u.role || 'ADMIN',
        registration: u.created_at || null,
        pendingInvite: !!u.invite_token,
        locations: (await accessFor(u.email)).map(a => ({ reference: a.reference, name: a.name })),
      })
    }

    // The logged-in user themselves (shown greyed-out, no actions).
    const selfRows = (await sql`
      SELECT first_name, last_name, role, created_at::text AS created_at
      FROM disco_restaurant_accounts WHERE email = ${ctx.email} LIMIT 1
    `) as Array<{ first_name: string | null; last_name: string | null; role: string | null; created_at: string | null }>
    const selfRow = selfRows[0]
    const self = {
      email: ctx.email,
      firstName: selfRow?.first_name || ctx.firstName || '',
      lastName: selfRow?.last_name || ctx.lastName || '',
      role: selfRow?.role || ctx.role || 'SYSTEM_ADMIN',
      registration: selfRow?.created_at || null,
      locations: (await accessFor(ctx.email)).map(a => ({ reference: a.reference, name: a.name })),
    }

    // Backward-compat: the (hidden) standalone Team page still reads `subAdmins`.
    const subAdmins = users.filter(u => u.role === 'SYSTEM_ADMIN')

    return NextResponse.json({ self, users, locations: locationList, subAdmins })
  } catch (err) {
    console.error('[restaurant/team] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to load team' }, { status: 500 })
  }
}
