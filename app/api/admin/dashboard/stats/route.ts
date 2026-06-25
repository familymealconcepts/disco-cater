import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/dashboard/stats — Disco platform count metrics from Neon.
//
// TOTAL RESTAURANTS = active, Stripe-connected restaurants on the platform:
// visible = true AND stripe_connected = true in disco_restaurant_overrides.
// (Was previously the raw FM restaurant-list length, which counted every
// restaurant regardless of whether it was live or Stripe-connected.)
export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await runMigrations()
    const rows = (await sql`
      SELECT COUNT(*)::int AS c
      FROM disco_restaurant_overrides
      WHERE stripe_connected = true AND visible = true
    `) as { c: number }[]
    return NextResponse.json({ activeRestaurants: rows[0]?.c ?? 0 })
  } catch (e) {
    console.error('[admin/dashboard/stats] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
