import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { runDiscoOrderMigrations, sql } from '../../../../../../lib/db'
import { grantLocationAccess, getHomeLocationRef } from '../../../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/system-admins/{email}/locations
// Current location access for a System Admin, with restaurant name + live status
// (from disco_restaurant_cache) and a `home` flag for the original/home location
// (which the UI must not allow removing).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id: rawEmail } = await params
  const email = decodeURIComponent(rawEmail || '').trim()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()
    const home = await getHomeLocationRef(email)
    const rows = (await sql`
      SELECT la.restaurant_reference,
             COALESCE(c.name, '') AS name,
             COALESCE(c.address, '') AS address,
             COALESCE(c.is_live, false) AS is_live
      FROM disco_restaurant_location_access la
      LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = la.restaurant_reference
      WHERE la.account_email = ${email}
      ORDER BY la.id ASC
    `) as Array<{ restaurant_reference: string; name: string; address: string; is_live: boolean }>

    return NextResponse.json({
      home,
      locations: rows.map(r => ({
        reference: r.restaurant_reference,
        name: r.name,
        address: r.address,
        isLive: r.is_live === true,
        isHome: r.restaurant_reference === home,
      })),
    })
  } catch (err) {
    console.error('[admin/system-admins/locations] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to load locations' }, { status: 500 })
  }
}

// POST /api/admin/system-admins/{email}/locations  { restaurantReference }
// Grants the System Admin access to a location.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let adminEmail: string | null = null
  try { await getAdminAuthHeader(); adminEmail = await getAdminEmail().catch(() => null) } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { id: rawEmail } = await params
  const email = decodeURIComponent(rawEmail || '').trim()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })

  try {
    const body = await req.json().catch(() => ({}))
    const ref = String(body?.restaurantReference || '').trim()
    if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

    await runDiscoOrderMigrations()
    await grantLocationAccess(email, ref, adminEmail || 'SUPER_ADMIN')
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin/system-admins/locations] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to add location' }, { status: 500 })
  }
}
