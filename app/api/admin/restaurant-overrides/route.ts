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
      // FULL OUTER JOIN so disco-native restaurants (which may have a cache row
      // but no overrides row) still appear in the admin table.
      const rows = (await sql`
        SELECT COALESCE(o.restaurant_reference, c.restaurant_reference) AS restaurant_reference,
               o.is_premium, o.visible, o.stripe_connected,
               o.stripe_checked_at, o.order_url, o.online_ordering_enabled, c.menu_upload_url,
               c.is_live, c.is_disco_native,
               -- Disco-native restaurants connect Stripe via disco_restaurant_accounts;
               -- expose whether a Stripe account exists as a connection fallback.
               (a.stripe_account_id IS NOT NULL) AS has_stripe_account
        FROM disco_restaurant_overrides o
        FULL OUTER JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
        LEFT JOIN LATERAL (
          SELECT stripe_account_id FROM disco_restaurant_accounts a2
          WHERE a2.restaurant_reference = COALESCE(o.restaurant_reference, c.restaurant_reference)
            AND a2.stripe_account_id IS NOT NULL
          LIMIT 1
        ) a ON true
      `) as {
        restaurant_reference: string; is_premium: boolean | null; visible: boolean | null
        stripe_connected: boolean | null; stripe_checked_at: string | null
        order_url: string | null; online_ordering_enabled: boolean | null; menu_upload_url: string | null
        is_live: boolean | null; is_disco_native: boolean | null; has_stripe_account: boolean | null
      }[]

      // Disco-native restaurants connect Stripe under their Disco reference, which
      // does NOT match the FM restaurant reference the admin table is keyed by. The
      // reliable link between an FM row and its Disco record is the admin EMAIL, so
      // expose every Disco account email that IS Stripe-connected. The table matches
      // FM rows by adminEmail against this list.
      const discoRows = (await sql`
        SELECT DISTINCT LOWER(email) AS email FROM disco_restaurant_accounts
        WHERE email IS NOT NULL AND email <> ''
          AND stripe_account_id IS NOT NULL AND stripe_onboarding_complete = true
      `) as { email: string }[]
      const discoStripeEmails = discoRows.map((r) => r.email)

      return NextResponse.json({
        discoStripeEmails,
        overrides: rows.map((r) => ({
          restaurantReference: r.restaurant_reference,
          isPremium: r.is_premium ?? false,
          visible: r.visible ?? false,
          stripeConnected: r.stripe_connected ?? false,
          stripeCheckedAt: r.stripe_checked_at,
          orderUrl: r.order_url ?? '',
          onlineOrderingEnabled: r.online_ordering_enabled ?? false,
          menuUploadUrl: r.menu_upload_url ?? null,
          isLive: r.is_live ?? false,
          isDiscoNative: r.is_disco_native ?? false,
          hasStripeAccount: r.has_stripe_account ?? false,
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

    await runMigrations()

    // is_live is a disco-native marketplace toggle living on the cache row — a
    // super admin can flip a disco-native restaurant live/offline directly.
    // Handled independently of the overrides upsert.
    if (typeof body?.isLive === 'boolean') {
      await sql`
        UPDATE disco_restaurant_cache
        SET is_live = ${body.isLive}, cached_at = NOW()
        WHERE restaurant_reference = ${restaurantReference}
      `
      // If only isLive was sent, we're done.
      if (body?.isPremium === undefined && body?.visible === undefined && body?.orderUrl === undefined) {
        return NextResponse.json({ ok: true, restaurantReference, isLive: body.isLive })
      }
    }

    const isPremium = body?.isPremium === true
    const visible = body?.visible === true
    const orderUrl: string | null = body?.orderUrl ? String(body.orderUrl) : null

    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, is_premium, visible, order_url, updated_at)
      VALUES (${restaurantReference}, ${isPremium}, ${visible}, ${orderUrl}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE
        SET is_premium = EXCLUDED.is_premium,
            visible = EXCLUDED.visible,
            order_url = EXCLUDED.order_url,
            updated_at = NOW()
    `

    // Two-way marketplace sync: a restaurant shown on the marketplace is also
    // "live" on the map, and its Disco account (if any) reflects the opt-in. Only
    // when `visible` was explicitly part of this request (Marketplace toggle / edit
    // dialog), so a Premium-only or order_url-only PATCH doesn't flip live status.
    if (typeof body?.visible === 'boolean') {
      await sql`
        UPDATE disco_restaurant_cache SET is_live = ${visible}, cached_at = NOW()
        WHERE restaurant_reference = ${restaurantReference}
      `.catch((e: unknown) => console.error('[restaurant-overrides] is_live sync failed:', e instanceof Error ? e.message : e))
      await sql`
        UPDATE disco_restaurant_accounts SET joined_marketplace = ${visible}, updated_at = NOW()
        WHERE restaurant_reference = ${restaurantReference}
      `.catch((e: unknown) => console.error('[restaurant-overrides] joined_marketplace sync failed:', e instanceof Error ? e.message : e))
    }

    return NextResponse.json({ ok: true, restaurantReference, isPremium, visible, orderUrl })
  } catch (e) {
    console.error('[restaurant-overrides] PATCH failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save override' }, { status: 500 })
  }
}
