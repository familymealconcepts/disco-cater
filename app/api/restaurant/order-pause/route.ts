import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { restaurantActorEmail } from '../../../../lib/settings-audit'
import { readOrderPause } from '../../../../lib/order/order-pause'
import { writeOrderPause, listMenusForPause } from '../../../../lib/order/order-pause-write'

export const dynamic = 'force-dynamic'

// "Pause new orders" for the restaurant portal's Settings page (lib/order/order-pause.ts).
// GET  ?restaurant_reference=  → { pausedUntil, excludedMenus, active, message }
// PUT  ?restaurant_reference=  body { pausedUntil: 'YYYY-MM-DD' | null, excludedMenus?: string[] }
// The target is the client-claimed reference verified against the caller's permitted set, as every
// portal settings write is (requireWritableRestaurantRef).
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const check = await requireWritableRestaurantRef(req.nextUrl.searchParams.get('restaurant_reference'))
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const p = await readOrderPause(check.ref)
  return NextResponse.json({ restaurantReference: check.ref, pausedUntil: p.pausedUntil, excludedMenus: p.excludedMenus, active: p.active, message: p.message, menus: await listMenusForPause(check.ref) })
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const check = await requireWritableRestaurantRef(req.nextUrl.searchParams.get('restaurant_reference'))
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  let body: { pausedUntil?: string | null; excludedMenus?: string[] }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  const r = await writeOrderPause({
    restaurantReference: check.ref,
    input: { pausedUntil: body.pausedUntil ?? null, excludedMenus: Array.isArray(body.excludedMenus) ? body.excludedMenus : [] },
    actorEmail: restaurantActorEmail(ctx),
    authType: ctx.authType === 'fm' ? 'fm' : 'disco',
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ pausedUntil: r.state.pausedUntil, excludedMenus: r.state.excludedMenus, active: r.state.active, message: r.state.message })
}
