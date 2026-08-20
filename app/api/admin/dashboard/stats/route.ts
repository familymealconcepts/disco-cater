import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../lib/db'
import { stripeReadySql } from '../../../../../lib/stripe-readiness'

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
    // A visible restaurant counts as Stripe-connected if its override says so OR it
    // has a linked, connected Disco account (matched by the FM restaurant reference
    // or the Disco reference) — so Disco-native restaurants aren't under-counted when
    // their override's stripe_connected reflects only a stale FM probe.
    const rows = (await sql`
      SELECT COUNT(*)::int AS c
      FROM disco_restaurant_overrides o
      WHERE o.visible = true AND (
        o.stripe_connected = true
        OR EXISTS (
          SELECT 1 FROM disco_restaurant_accounts a
          WHERE (a.restaurant_reference = o.restaurant_reference OR a.fm_restaurant_reference = o.restaurant_reference)
            AND ${sql.unsafe(stripeReadySql('a'))}
        )
      )
    `) as { c: number }[]
    return NextResponse.json({ activeRestaurants: rows[0]?.c ?? 0 })
  } catch (e) {
    console.error('[admin/dashboard/stats] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
