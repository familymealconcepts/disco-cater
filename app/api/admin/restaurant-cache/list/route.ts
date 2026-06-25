import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../../lib/db'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/restaurant-cache/list
// Flat list of every restaurant in disco_restaurant_cache for the order-transfer
// picker. Admin-cookie gated. Returns { restaurants: [{ reference, name }] }.
export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await runMigrations() // ensures disco_restaurant_cache exists
    const rows = (await sql`
      SELECT restaurant_reference AS reference, name, address, COALESCE(is_live, false) AS is_live
      FROM disco_restaurant_cache
      WHERE name IS NOT NULL AND name <> ''
      ORDER BY name ASC
    `) as Array<{ reference: string; name: string; address: string | null; is_live: boolean }>
    return NextResponse.json({
      restaurants: rows.map(r => ({ reference: r.reference, name: r.name, address: r.address || '', isLive: r.is_live === true })),
    })
  } catch (e) {
    console.error('[restaurant-cache/list] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load restaurants' }, { status: 500 })
  }
}
