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

  try {
    await runMigrations()

    // No ref → return ALL overrides (used by the Ordering table to show per-row
    // Premium / visibility / Stripe status without one call per restaurant).
    if (!ref) {
      const rows = (await sql`
        SELECT o.restaurant_reference, o.is_premium, o.visible, o.stripe_connected,
               o.stripe_checked_at, o.order_url, c.menu_upload_url
        FROM disco_restaurant_overrides o
        LEFT JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
      `) as {
        restaurant_reference: string; is_premium: boolean; visible: boolean
        stripe_connected: boolean; stripe_checked_at: string | null
        order_url: string | null; menu_upload_url: string | null
      }[]
      return NextResponse.json({
        overrides: rows.map((r) => ({
          restaurantReference: r.restaurant_reference,
          isPremium: r.is_premium,
          visible: r.visible,
          stripeConnected: r.stripe_connected,
          stripeCheckedAt: r.stripe_checked_at,
          orderUrl: r.order_url ?? '',
          menuUploadUrl: r.menu_upload_url ?? null,
        })),
      })
    }

    const rows = (await sql`
      SELECT restaurant_reference, is_premium, visible, stripe_connected, stripe_checked_at, order_url
      FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
    `) as {
      restaurant_reference: string; is_premium: boolean; visible: boolean
      stripe_connected: boolean; stripe_checked_at: string | null; order_url: string | null
    }[]
    const row = rows[0]
    return NextResponse.json({
      restaurantReference: ref,
      isPremium: row?.is_premium ?? false,
      visible: row?.visible ?? false,
      stripeConnected: row?.stripe_connected ?? false,
      stripeCheckedAt: row?.stripe_checked_at ?? null,
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
    const visible = body?.visible === true
    const orderUrl: string | null = body?.orderUrl ? String(body.orderUrl) : null

    await runMigrations()
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, is_premium, visible, order_url, updated_at)
      VALUES (${restaurantReference}, ${isPremium}, ${visible}, ${orderUrl}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET is_premium = EXCLUDED.is_premium,
            visible = EXCLUDED.visible,
            order_url = EXCLUDED.order_url,
            updated_at = NOW()
    `
    return NextResponse.json({ ok: true, restaurantReference, isPremium, visible, orderUrl })
  } catch (e) {
    console.error('[restaurant-overrides] PATCH failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save override' }, { status: 500 })
  }
}
