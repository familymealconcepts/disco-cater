import { NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Count cards: Active/Available Menus, Active/Available Add-Ons, Today's/Scheduled
// Orders. FM's /api/dashboard/stats needs a real ADMIN token (the service account
// isn't accepted, and FM has no per-restaurant equivalent), so Disco-native
// sessions used to fall back to all-zeros even when Neon had real data. They now
// compute real counts from Neon, scoped to the currently-selected location.
const ZERO_STATS = {
  activeMealPackagesCount: 0,
  availableMealPackagesCount: 0,
  activeAddOnsCount: 0,
  availableAddOnsCount: 0,
  scheduleOrdersCount: 0,
  todayOrdersCount: 0,
}

const n = (v: unknown) => Number(v) || 0

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── Disco-native: real counts from Neon (menus, add-ons, orders), scoped to the
  // currently-selected location (resolveDiscoScopeRef). FM-backed restaurants keep
  // the FM path below, unchanged. ──
  if (ctx.authType === 'disco') {
    try {
      const ref = await resolveDiscoScopeRef(ctx)
      if (!ref) return NextResponse.json(ZERO_STATS)

      const tzRows = (await sql`SELECT timezone FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { timezone: string | null }[]
      const tz = tzRows[0]?.timezone || 'America/New_York'

      const menu = (await sql`
        SELECT count(*) FILTER (WHERE archived = false) AS available,
               count(*) FILTER (WHERE archived = false AND visible = true) AS active
        FROM disco_menus WHERE restaurant_reference = ${ref}::uuid
      `) as { available: string; active: string }[]

      const addon = (await sql`
        SELECT count(*) FILTER (WHERE archived = false) AS available,
               count(*) FILTER (WHERE archived = false AND visible = true) AS active
        FROM disco_modifiers WHERE restaurant_reference = ${ref}::uuid
      `) as { available: string; active: string }[]

      const orders = (await sql`
        SELECT
          count(*) FILTER (
            WHERE order_date = (NOW() AT TIME ZONE ${tz})::date
              AND order_status IN ('DUE','PAID','COMPLETED','RESERVED')
          ) AS today,
          count(*) FILTER (
            WHERE order_date > (NOW() AT TIME ZONE ${tz})::date
              AND order_status IN ('DUE','PAID','RESERVED')
          ) AS scheduled
        FROM disco_orders WHERE restaurant_reference = ${ref}::uuid AND is_deleted = false
      `) as { today: string; scheduled: string }[]

      return NextResponse.json({
        activeMealPackagesCount: n(menu[0]?.active),
        availableMealPackagesCount: n(menu[0]?.available),
        activeAddOnsCount: n(addon[0]?.active),
        availableAddOnsCount: n(addon[0]?.available),
        todayOrdersCount: n(orders[0]?.today),
        scheduleOrdersCount: n(orders[0]?.scheduled),
      })
    } catch (e) {
      console.error('[dashboard/stats] native stats failed:', e instanceof Error ? e.message : e)
      return NextResponse.json(ZERO_STATS)
    }
  }

  // ── FM-backed: unchanged ──
  const authHeaders = await getFmHeaderForRestaurant(ctx)
  try {
    const res = await fetch(`${FM}/api/dashboard/stats`, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
