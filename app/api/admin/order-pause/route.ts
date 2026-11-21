import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader, getAdminEmail } from '../../../../lib/admin-auth'
import { readOrderPause } from '../../../../lib/order/order-pause'
import { writeOrderPause, listMenusForPause } from '../../../../lib/order/order-pause-write'

export const dynamic = 'force-dynamic'

// "Pause new orders" for Super Admin → Manage Restaurants → Edit (lib/order/order-pause.ts).
// GET ?restaurantReference=  → the pause + the restaurant's menus (for the excluded-menus picker)
// PUT  body { restaurantReference, pausedUntil: 'YYYY-MM-DD' | null, excludedMenus?: string[] }
// A Disco-native restaurant listed under a leftover FM ref is remapped to its native ref, the row the
// order gate reads — same remap as /api/admin/restaurant-overrides.
async function canonicalRef(ref: string): Promise<string> {
  try {
    const nr = (await sql`
      SELECT restaurant_reference AS native_ref FROM disco_restaurant_accounts
      WHERE is_disco_native = true AND fm_restaurant_reference = ${ref} LIMIT 1
    `) as { native_ref: string }[]
    return nr[0]?.native_ref || ref
  } catch { return ref }
}

export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const claimed = req.nextUrl.searchParams.get('restaurantReference') || ''
  if (!claimed) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })
  const ref = await canonicalRef(claimed)
  const p = await readOrderPause(ref)
  const menus = await listMenusForPause(ref)
  return NextResponse.json({ restaurantReference: ref, pausedUntil: p.pausedUntil, excludedMenus: p.excludedMenus, active: p.active, message: p.message, menus })
}

export async function PUT(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const body = (await req.json().catch(() => null)) as { restaurantReference?: string; pausedUntil?: string | null; excludedMenus?: string[] } | null
  if (!body?.restaurantReference) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })
  const ref = await canonicalRef(body.restaurantReference)
  const r = await writeOrderPause({
    restaurantReference: ref,
    input: { pausedUntil: body.pausedUntil ?? null, excludedMenus: Array.isArray(body.excludedMenus) ? body.excludedMenus : [] },
    actorEmail: await getAdminEmail().catch(() => null),
    authType: 'admin',
  })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ restaurantReference: ref, pausedUntil: r.state.pausedUntil, excludedMenus: r.state.excludedMenus, active: r.state.active, message: r.state.message })
}
