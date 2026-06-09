import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Disco-owned per-restaurant overrides (Premium flag + order-URL) stored in Neon.
// Admin-only (gated on the admin session cookie). The public /api/restaurants
// reads these and merges them onto the live FM restaurant records.

// GET /api/admin/restaurant-overrides?restaurantReference=... → current values
// (defaults when no row yet) so the edit dialog can populate the toggle + field.
export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const ref = req.nextUrl.searchParams.get('restaurantReference')
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

  try {
    await runMigrations()
    const rows = (await sql`
      SELECT restaurant_reference, is_premium, order_url
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { restaurant_reference: string; is_premium: boolean; order_url: string | null }[]
    const row = rows[0]
    return NextResponse.json({
      restaurantReference: ref,
      isPremium: row?.is_premium ?? false,
      orderUrl: row?.order_url ?? '',
    })
  } catch (e) {
    console.error('[restaurant-overrides] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load override' }, { status: 500 })
  }
}

// PATCH /api/admin/restaurant-overrides — body { restaurantReference, isPremium, orderUrl }
export async function PATCH(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    const body = await req.json().catch(() => null)
    const restaurantReference: string | undefined = body?.restaurantReference
    if (!restaurantReference) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })
    const isPremium = body?.isPremium === true
    const orderUrl: string | null = body?.orderUrl ? String(body.orderUrl) : null

    await runMigrations()
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, is_premium, order_url, updated_at)
      VALUES (${restaurantReference}, ${isPremium}, ${orderUrl}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET is_premium = EXCLUDED.is_premium,
            order_url = EXCLUDED.order_url,
            updated_at = NOW()
    `
    return NextResponse.json({ ok: true, restaurantReference, isPremium, orderUrl })
  } catch (e) {
    console.error('[restaurant-overrides] PATCH failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save override' }, { status: 500 })
  }
}
