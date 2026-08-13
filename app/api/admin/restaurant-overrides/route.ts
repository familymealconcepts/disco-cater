import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations, runMenuDriftMigrations } from '../../../../lib/db'
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
    await runMenuDriftMigrations().catch(() => {})

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
               (a.stripe_account_id IS NOT NULL) AS has_stripe_account,
               d.has_drift AS menu_drift_detected, d.drift_details AS menu_drift_details,
               -- A native restaurant whose admin invite died unused: a token was
               -- issued but its window has passed with nobody ever accepting it
               -- (acceptInvite nulls the token on success, so a non-null token
               -- past expiry means it's still sitting there, unusable).
               inv.invite_expired
        FROM disco_restaurant_overrides o
        FULL OUTER JOIN disco_restaurant_cache c ON c.restaurant_reference = o.restaurant_reference
        LEFT JOIN LATERAL (
          SELECT stripe_account_id FROM disco_restaurant_accounts a2
          WHERE (a2.restaurant_reference = COALESCE(o.restaurant_reference, c.restaurant_reference)
                 OR a2.fm_restaurant_reference = COALESCE(o.restaurant_reference, c.restaurant_reference))
            AND a2.stripe_account_id IS NOT NULL
          LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT (invite_token IS NOT NULL AND invite_token_expires_at < NOW()) AS invite_expired
          FROM disco_restaurant_accounts a3
          WHERE a3.restaurant_reference = COALESCE(o.restaurant_reference, c.restaurant_reference)
             OR a3.fm_restaurant_reference = COALESCE(o.restaurant_reference, c.restaurant_reference)
          ORDER BY a3.created_at ASC LIMIT 1
        ) inv ON true
        LEFT JOIN disco_menu_drift_snapshots d ON d.restaurant_reference::text = COALESCE(o.restaurant_reference, c.restaurant_reference)
      `) as {
        restaurant_reference: string; is_premium: boolean | null; visible: boolean | null
        stripe_connected: boolean | null; stripe_checked_at: string | null
        order_url: string | null; online_ordering_enabled: boolean | null; menu_upload_url: string | null
        is_live: boolean | null; is_disco_native: boolean | null; has_stripe_account: boolean | null
        menu_drift_detected: boolean | null; menu_drift_details: unknown | null; invite_expired: boolean | null
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

      type OverrideDto = {
        restaurantReference: string; isPremium: boolean; visible: boolean; stripeConnected: boolean
        stripeCheckedAt: string | null; orderUrl: string; onlineOrderingEnabled: boolean | null
        menuUploadUrl: string | null; isLive: boolean; isDiscoNative: boolean; hasStripeAccount: boolean
        menuDriftDetected: boolean; menuDriftDetails: unknown[]; inviteExpired: boolean
      }
      const byRef = new Map<string, OverrideDto>()
      for (const r of rows) {
        byRef.set(r.restaurant_reference, {
          restaurantReference: r.restaurant_reference,
          isPremium: r.is_premium ?? false,
          visible: r.visible ?? false,
          stripeConnected: r.stripe_connected ?? false,
          stripeCheckedAt: r.stripe_checked_at,
          orderUrl: r.order_url ?? '',
          // Raw nullable value so the client can tell "explicitly set" from "unset":
          // an unset disco-native restaurant defaults to ON (matches the order gate's
          // COALESCE(online_ordering_enabled, true) and the portal settings default).
          onlineOrderingEnabled: r.online_ordering_enabled,
          menuUploadUrl: r.menu_upload_url ?? null,
          isLive: r.is_live ?? false,
          isDiscoNative: r.is_disco_native ?? false,
          hasStripeAccount: r.has_stripe_account ?? false,
          menuDriftDetected: r.menu_drift_detected ?? false,
          menuDriftDetails: (r.menu_drift_details as unknown[]) ?? [],
          inviteExpired: (r.is_disco_native ?? false) && (r.invite_expired ?? false),
        })
      }

      // A Disco-native restaurant that carries a LEFTOVER FM reference appears in
      // the admin list under that FM ref, but its real state lives on the NATIVE-ref
      // overrides + cache rows. Overlay the native values onto the FM-ref key so the
      // admin marketplace / online-ordering toggles reflect the restaurant's true
      // native state — no data cleanup needed. Genuinely FM-backed restaurants have
      // no such native account, so they're untouched. (Writes are remapped to the
      // native ref in PATCH, keeping the two sides two-way synced.)
      const nativeRows = (await sql`
        SELECT a.fm_restaurant_reference AS fm_ref,
               o.is_premium, o.visible, o.stripe_connected, o.stripe_checked_at, o.order_url,
               o.online_ordering_enabled, c.menu_upload_url, c.is_live,
               (a.stripe_account_id IS NOT NULL) AS has_stripe_account,
               d.has_drift AS menu_drift_detected, d.drift_details AS menu_drift_details,
               (a.invite_token IS NOT NULL AND a.invite_token_expires_at < NOW()) AS invite_expired
        FROM disco_restaurant_accounts a
        JOIN disco_restaurant_cache c ON c.restaurant_reference = a.restaurant_reference AND c.is_disco_native = true
        LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = a.restaurant_reference
        LEFT JOIN disco_menu_drift_snapshots d ON d.restaurant_reference::text = a.restaurant_reference
        WHERE a.is_disco_native = true AND a.fm_restaurant_reference IS NOT NULL
      `) as {
        fm_ref: string; is_premium: boolean | null; visible: boolean | null; stripe_connected: boolean | null
        stripe_checked_at: string | null; order_url: string | null; online_ordering_enabled: boolean | null
        menu_upload_url: string | null; is_live: boolean | null; has_stripe_account: boolean | null
        menu_drift_detected: boolean | null; menu_drift_details: unknown | null; invite_expired: boolean | null
      }[]
      for (const n of nativeRows) {
        if (!n.fm_ref) continue
        byRef.set(n.fm_ref, {
          restaurantReference: n.fm_ref,
          isPremium: n.is_premium ?? false,
          visible: n.visible ?? false,
          stripeConnected: n.stripe_connected ?? false,
          stripeCheckedAt: n.stripe_checked_at,
          orderUrl: n.order_url ?? '',
          onlineOrderingEnabled: n.online_ordering_enabled,
          menuUploadUrl: n.menu_upload_url ?? null,
          isLive: n.is_live ?? false,
          isDiscoNative: true,
          hasStripeAccount: n.has_stripe_account ?? false,
          menuDriftDetected: n.menu_drift_detected ?? false,
          menuDriftDetails: (n.menu_drift_details as unknown[]) ?? [],
          inviteExpired: n.invite_expired ?? false,
        })
      }

      return NextResponse.json({ discoStripeEmails, overrides: Array.from(byRef.values()) })
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
    let restaurantReference: string | undefined = body?.restaurantReference
    if (!restaurantReference) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

    await runMigrations()

    // A Disco-native restaurant with a leftover FM reference is shown in the admin
    // list under that FM ref, but its canonical overrides live on the NATIVE ref
    // (what the restaurant portal + order gate read). Remap so every admin write
    // below lands on the row that actually governs behavior — mirroring the GET
    // overlay. Non-native / genuinely-FM restaurants: no match → no remap.
    try {
      const nr = (await sql`
        SELECT restaurant_reference AS native_ref FROM disco_restaurant_accounts
        WHERE is_disco_native = true AND fm_restaurant_reference = ${restaurantReference} LIMIT 1
      `) as { native_ref: string }[]
      if (nr[0]?.native_ref) restaurantReference = nr[0].native_ref
    } catch { /* non-UUID / lookup miss → keep the original reference */ }

    // online_ordering_enabled — the canonical "Accept online orders" flag both the
    // restaurant portal (disco-settings / online-ordering) and the native order-gate
    // read. Handled independently so an ordering-only PATCH from the admin toggle
    // doesn't clobber visible / is_premium / order_url on the same row.
    if (typeof body?.onlineOrderingEnabled === 'boolean') {
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, online_ordering_enabled, updated_at)
        VALUES (${restaurantReference}, ${body.onlineOrderingEnabled}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE
          SET online_ordering_enabled = EXCLUDED.online_ordering_enabled, updated_at = NOW()
      `
      if (body?.isPremium === undefined && body?.visible === undefined && body?.orderUrl === undefined && body?.isLive === undefined) {
        return NextResponse.json({ ok: true, restaurantReference, onlineOrderingEnabled: body.onlineOrderingEnabled })
      }
    }

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
