import { NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant, usesServiceAccount } from '../../../../../lib/restaurant-auth-context'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Count cards (active/available menus, today/scheduled orders, add-ons). FM's
// /api/dashboard/stats requires an ADMIN/SYSTEM_ADMIN token (which the service
// account isn't), and FM has no per-restaurant SUPER_ADMIN equivalent — the
// admin dashboard only aggregates across ALL restaurants. New Disco partners have
// no menus/orders yet, so return zeros (the page reads each value with `?? 0`).
const ZERO_STATS = {
  activeMealPackagesCount: 0,
  availableMealPackagesCount: 0,
  activeAddOnsCount: 0,
  availableAddOnsCount: 0,
  scheduleOrdersCount: 0,
  todayOrdersCount: 0,
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  if (usesServiceAccount(ctx)) {
    return NextResponse.json(ZERO_STATS)
  }

  const authHeaders = await getFmHeaderForRestaurant(ctx)
  try {
    const res = await fetch(`${FM}/api/dashboard/stats`, { headers: authHeaders })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch stats' }, { status: 500 })
  }
}
