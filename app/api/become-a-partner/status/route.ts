import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/become-a-partner/status?restaurantReference=...
// Drives the Go-Live checklist. Returns the four completion booleans + isLive.
export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get('restaurantReference') || '').trim()
  const empty = { accountCreated: false, profileComplete: false, stripeConnected: false, menuUploaded: false, isLive: false }
  if (!ref) return NextResponse.json(empty)

  try {
    await runMigrations()

    const acctRows = (await sql`
      SELECT onboarding_step
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} ORDER BY id ASC LIMIT 1
    `) as { onboarding_step: number | null }[]
    const acct = acctRows[0]

    const ovrRows = (await sql`
      SELECT stripe_onboarding_complete FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { stripe_onboarding_complete: boolean | null }[]
    const ovr = ovrRows[0]

    const cacheRows = (await sql`
      SELECT lat, lng, is_live FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { lat: string | null; lng: string | null; is_live: boolean | null }[]
    const cache = cacheRows[0]

    let menuCount = 0
    if (UUID_RE.test(ref)) {
      try {
        await runDiscoMenuMigrations()
        const c = (await sql`SELECT COUNT(*)::int AS c FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid`) as { c: number }[]
        menuCount = c[0]?.c ?? 0
      } catch { /* menu tables best-effort */ }
    }

    return NextResponse.json({
      accountCreated: !!acct,
      profileComplete: !!cache && cache.lat != null && cache.lng != null,
      stripeConnected: !!ovr?.stripe_onboarding_complete,
      menuUploaded: menuCount > 0,
      isLive: !!cache?.is_live,
    })
  } catch (err) {
    console.error('[partner/status] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(empty)
  }
}
