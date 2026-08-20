import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sql, runMigrations } from '../../../../lib/db'
import { sendEmail } from '../../../../lib/email/send'
import { layout, button } from '../../../../lib/email/layout'
import { createFmRestaurant } from '../../../../lib/become-a-partner/fm-create'
import {
  hashPassword,
  createDiscoRestaurantSession,
  getDiscoRestaurantAccount,
  DISCO_RESTAURANT_COOKIE,
  DISCO_RESTAURANT_COOKIE_OPTS,
} from '../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
// Prefer a dedicated partner webhook; otherwise reuse the new-order webhook so
// signups still reach Slack (with a distinct message so they're not mistaken
// for orders).
const SLACK_WEBHOOK_URL = process.env.SLACK_PARTNER_WEBHOOK_URL || process.env.SLACK_NEW_ORDER_WEBHOOK_URL
const TEAM_EMAIL = 'concierge@discocater.com'

// FM restaurant creation ultimately failed for a signup — mark the account (so
// super-admin flags it) and alert the team on Slack, so it's never silent.
async function flagFmCreationFailure(email: string, restaurantName: string, detail: string): Promise<void> {
  try {
    await sql`UPDATE disco_restaurant_accounts SET fm_creation_failed = true, fm_creation_error = ${detail.slice(0, 500)} WHERE email = ${email}`
  } catch (e) { console.error('[complete] mark fm_creation_failed:', e instanceof Error ? e.message : e) }
  if (!SLACK_WEBHOOK_URL) return
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: [
          `:warning: *FamilyMeal record creation FAILED* — ${restaurantName}`,
          `Email: ${email}`,
          `Error: ${detail}`,
          `This restaurant is live in Disco but has no FM record — it shows as "Disco-only (no FM record)" in super-admin until repaired.`,
        ].join('\n'),
      }),
    })
  } catch (e) { console.error('[complete] Slack fm-fail notify failed:', e instanceof Error ? e.message : e) }
}

// Server-side geocode (address → lat/lng) via the Google Geocoding API. Returns
// null on any failure so onboarding never blocks on geocoding.
// Keyless fallback (OpenStreetMap Nominatim — same geocoder fullmap's own
// "search a location" box already uses). Google's geocode call below can
// fail on a misconfigured/unauthorized API key (confirmed: this silently left
// several real native signups with lat/lng = null, invisible on the fullmap
// feed — /api/restaurants drops any row without coordinates). This fallback
// means a signup still gets real coordinates even while that key issue is
// unresolved, rather than every affected restaurant needing a manual fix.
async function geocodeViaNominatim(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'DiscoCater/1.0 (concierge@discocater.com)' } },
    )
    const data = await res.json().catch(() => null)
    const hit = Array.isArray(data) ? data[0] : null
    if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) {
      return { lat: Number(hit.lat), lng: Number(hit.lon) }
    }
  } catch (err) {
    console.error('[complete] Nominatim geocode fallback failed:', err instanceof Error ? err.message : err)
  }
  return null
}

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  if (!address) return null
  const key = process.env.GOOGLE_PLACES_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY
  if (key) {
    try {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`)
      const data = await res.json().catch(() => null)
      const loc = data?.results?.[0]?.geometry?.location
      if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
        return { lat: Number(loc.lat), lng: Number(loc.lng) }
      }
      if (data?.status && data.status !== 'OK') {
        console.error('[complete] Google geocode non-OK status (falling back to Nominatim):', data.status, data.error_message)
      }
    } catch (err) {
      console.error('[complete] Google geocode threw (falling back to Nominatim):', err instanceof Error ? err.message : err)
    }
  }
  return geocodeViaNominatim(address)
}

// Finalizes onboarding: this is the ONLY place a full account is provisioned.
// 1) FM account (best-effort), 2) create/update disco_restaurant_accounts,
// 3) location-access entry, 4) is_live=true cache row, 5) Disco session + cookie,
// 6) welcome email + Slack, 7) { success: true }. Idempotent / retry-safe.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = String(body?.email || '').trim().toLowerCase()
  const password = String(body?.password || '')
  const firstName = String(body?.firstName || '').trim()
  const lastName = String(body?.lastName || '').trim()
  const restaurantName = String(body?.restaurantName || '').trim() || 'Unknown Restaurant'
  const phone = String(body?.phone || body?.phoneNumber || '').trim()
  const street = String(body?.street || '').trim()
  const city = String(body?.city || '').trim()
  const state = String(body?.state || '').trim()
  const zip = String(body?.zip || '').trim()
  const logoUrl = String(body?.logoUrl || '').trim() || null
  const iconUrl = String(body?.iconUrl || '').trim() || null
  const joinedMarketplace = !!body?.joinedMarketplace
  const deliveryEnabled = !!body?.deliveryEnabled
  const stripeConnected = !!body?.stripeConnected
  const menuFileName = String(body?.menuFileName || '').trim()

  if (!email) return NextResponse.json({ error: 'Email is required.' }, { status: 400 })

  const address = [street, city, state, zip].filter(Boolean).join(', ')
  const location = [city, state].filter(Boolean).join(', ')
  const slug = restaurantName.toLowerCase().replace(/[^a-z0-9]/g, '')

  try {
    await runMigrations()

    // ── 2) Create or update the disco_restaurant_accounts row ──────────────────
    // (Done before FM so the canonical Disco reference is stable. The account may
    // already exist from the Stripe step — then we only enrich the profile.)
    const existing = await getDiscoRestaurantAccount(email)
    let ref = (existing?.restaurant_reference as string | undefined) || String(body?.restaurantReference || '').trim() || randomUUID()

    // Name/phone/address live on disco_restaurant_cache (upserted below), not here.
    if (existing) {
      await sql`
        UPDATE disco_restaurant_accounts
        SET first_name = COALESCE(NULLIF(${firstName}, ''), first_name),
            last_name = COALESCE(NULLIF(${lastName}, ''), last_name),
            is_disco_native = true,
            onboarding_step = GREATEST(COALESCE(onboarding_step, 0), 4),
            updated_at = NOW()
        WHERE email = ${email}
      `
    } else {
      // Brand-new account (e.g. Stripe was skipped). Requires the password.
      if (!password || password.length < 8) {
        return NextResponse.json({ error: 'A password (8+ characters) is required to create your account.' }, { status: 400 })
      }
      const passwordHash = await hashPassword(password)
      await sql`
        INSERT INTO disco_restaurant_accounts (
          email, password_hash, restaurant_reference, first_name, last_name, role, is_disco_native, onboarding_step
        ) VALUES (
          ${email}, ${passwordHash}, ${ref}, ${firstName || null}, ${lastName || null},
          'ADMIN', true, 4
        )
        ON CONFLICT (email) DO NOTHING
      `
      // Resolve the canonical reference after a possible concurrent insert.
      const re = (await sql`SELECT restaurant_reference FROM disco_restaurant_accounts WHERE email = ${email} LIMIT 1`) as { restaurant_reference: string }[]
      if (re[0]?.restaurant_reference) ref = re[0].restaurant_reference
    }

    // ── 1) FM account (best-effort — never blocks completion) ──────────────────
    // Records the FM admin reference when FM succeeds; a 400-027 (email already in
    // FM) or any other failure is logged and ignored. The Disco reference above
    // stays canonical regardless.
    try {
      const fm = await createFmRestaurant({
        restaurantName, email, phoneNumber: phone, firstName, lastName,
        zipcode: zip, password, addressLine1: street, city, state,
      })
      if (fm.ok) {
        // Store BOTH FM references: the admin USER ref (fm_user_reference) and the
        // RESTAURANT ref (fm_restaurant_reference). The restaurant ref links this
        // Disco account to the FM record the super-admin surfaces are keyed by.
        // Clear any prior failure marker (e.g. a retry that now succeeded).
        await sql`
          UPDATE disco_restaurant_accounts
          SET fm_user_reference = COALESCE(fm_user_reference, ${fm.adminReference}),
              fm_restaurant_reference = COALESCE(fm_restaurant_reference, ${fm.reference}),
              fm_creation_failed = false, fm_creation_error = NULL
          WHERE email = ${email}
        `
      } else {
        console.warn('[complete] FM creation failed after retries (continuing):', fm.code || fm.status, fm.error)
        await flagFmCreationFailure(email, restaurantName, `${fm.code || fm.status}: ${fm.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[complete] FM creation threw (continuing):', msg)
      await flagFmCreationFailure(email, restaurantName, `threw: ${msg}`)
    }

    // ── 4) Upsert the marketplace cache row and flip it live ───────────────────
    const coords = address ? await geocode(address) : null
    await sql`
      INSERT INTO disco_restaurant_cache
        (restaurant_reference, name, slug, address, location, lat, lng, cuisine, phone, image_url, icon_url, is_disco_native, is_live, cached_at)
      VALUES (${ref}, ${restaurantName}, ${slug}, ${address || null}, ${location || null},
              ${coords?.lat ?? null}, ${coords?.lng ?? null}, ${'Other'}, ${phone || null}, ${logoUrl}, ${iconUrl},
              true, ${joinedMarketplace}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        name = EXCLUDED.name,
        slug = COALESCE(EXCLUDED.slug, disco_restaurant_cache.slug),
        address = EXCLUDED.address,
        location = EXCLUDED.location,
        lat = COALESCE(EXCLUDED.lat, disco_restaurant_cache.lat),
        lng = COALESCE(EXCLUDED.lng, disco_restaurant_cache.lng),
        phone = EXCLUDED.phone,
        image_url = COALESCE(EXCLUDED.image_url, disco_restaurant_cache.image_url),
        icon_url = COALESCE(EXCLUDED.icon_url, disco_restaurant_cache.icon_url),
        is_disco_native = true,
        is_live = ${joinedMarketplace},
        cached_at = NOW()
    `
    // Persist the marketplace opt-in the restaurant made at onboarding: setting the
    // Marketplace toggle (disco_restaurant_overrides.visible) ON when they chose to
    // join, plus the joined_marketplace mirror. Actual public visibility is still
    // gated by the 3-part rule in /api/restaurants (Stripe connected + this toggle +
    // online ordering), so auto-enabling here bypasses no safety check — it just
    // avoids a manual admin step after they've already told us they want to list.
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, is_premium, stripe_connected)
      VALUES (${ref}, ${joinedMarketplace}, false, ${stripeConnected})
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = ${joinedMarketplace}, stripe_connected = ${stripeConnected}
    `
    await sql`
      UPDATE disco_restaurant_accounts SET joined_marketplace = ${joinedMarketplace}, updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `.catch((e: unknown) => console.error('[complete] joined_marketplace persist failed:', e instanceof Error ? e.message : e))

    // Record the submitted menu reference (best-effort) for the super admin — but
    // only as a fallback. The menu-upload step already stored the durable Blob URL
    // in menu_upload_url; never clobber that real URL with the bare local filename
    // (which resolves to nothing in super admin's "View Menu").
    if (menuFileName) {
      try {
        await sql`
          UPDATE disco_restaurant_cache SET menu_upload_url = ${menuFileName}
          WHERE restaurant_reference = ${ref}
            AND (menu_upload_url IS NULL OR menu_upload_url NOT LIKE 'http%')
        `
      } catch (err) {
        console.error('[complete] menu_upload_url save failed:', err instanceof Error ? err.message : err)
      }
    }

    // Note: a new partner is a single-location ADMIN (role set on the account row
    // above). We intentionally do NOT grant disco_restaurant_location_access here —
    // that table is the multi-location SYSTEM_ADMIN marker, and creating a row made
    // new partners resolve as SYSTEM_ADMIN. Their home location (the account's
    // restaurant_reference) is always accessible without it.

    // ── 5) Disco session + cookie (so the partner is logged in immediately) ────
    let token = ''
    try {
      token = await createDiscoRestaurantSession(ref, email)
    } catch (err) {
      console.error('[complete] session creation failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Your account was created but the session could not be started. Please log in.' }, { status: 500 })
    }

    const res = NextResponse.json({ success: true, restaurantReference: ref })
    res.cookies.set(DISCO_RESTAURANT_COOKIE, token, DISCO_RESTAURANT_COOKIE_OPTS)
    res.cookies.delete('fm_restaurant_token')
    res.cookies.delete('fm_restaurant_refresh')

    // ── 6) Welcome email + Slack (best-effort) ─────────────────────────────────
    const yn = (b: boolean) => (b ? 'Yes' : 'No')
    if (SLACK_WEBHOOK_URL) {
      try {
        await fetch(SLACK_WEBHOOK_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: [
              `*New Partner Signup* — ${restaurantName}`,
              `Email: ${email || 'Not provided'}`,
              `Phone: ${phone || 'Not provided'}`,
              `Zip: ${zip || 'Not provided'}`,
              `Marketplace: ${yn(joinedMarketplace)}`,
              `Delivery: ${yn(deliveryEnabled)}`,
              `Stripe: ${yn(stripeConnected)}`,
            ].join('\n'),
          }),
        })
      } catch (err) {
        console.error('[complete] Slack notify failed:', err instanceof Error ? err.message : err)
      }
    }

    // Welcome email to the partner (best-effort; sendEmail never throws).
    try {
      const content = `
        <p style="font-size:18px;font-weight:700;margin:0 0 12px;">Welcome to Disco Cater!</p>
        <p style="margin:0 0 12px;">Congratulations${firstName ? `, ${firstName}` : ''} — <strong>${restaurantName}</strong> is now set up on Disco Cater.</p>
        <p style="margin:0 0 12px;">Manage your orders, menu, and settings from your restaurant portal.</p>
        ${button('Go to your dashboard', 'https://www.discocater.com/restaurant/orders')}
      `
      await sendEmail({ to: email, subject: `Welcome to Disco Cater!`, html: layout(content) })
    } catch (err) {
      console.error('[complete] welcome email failed:', err instanceof Error ? err.message : err)
    }

    // Team email notification (best-effort).
    if (MAILGUN_DOMAIN) {
      const fields = [
        `Restaurant: ${restaurantName}`,
        `Contact email: ${email || 'Not provided'}`,
        `Phone: ${phone || 'Not provided'}`,
        `Zip: ${zip || 'Not provided'}`,
        `Restaurant ref: ${ref}`,
        '',
        `Joined marketplace (3P): ${yn(joinedMarketplace)}`,
        `Third-party delivery enabled: ${yn(deliveryEnabled)}`,
        `Stripe connected: ${yn(stripeConnected)}`,
        menuFileName ? `Menu: ${menuFileName}` : '',
      ].filter(Boolean)
      const text = `A restaurant has completed Disco Cater onboarding.\n\n${fields.join('\n')}\n\n— Disco Cater Onboarding`
      const html = `<p style="margin:0 0 12px;">A restaurant has completed Disco Cater onboarding.</p>
        <p style="margin:0 0 12px;">${fields.map(f => f ? f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '').join('<br/>')}</p>`
      try {
        const result = await sendEmail({
          to: TEAM_EMAIL,
          from: `Disco Cater Onboarding <onboarding@${MAILGUN_DOMAIN}>`,
          subject: `New Partner Onboarding Complete — ${restaurantName}`,
          html: layout(html),
          text,
        })
        if (!result.success) console.error(`[complete] team email send failed: ${result.error}`)
      } catch (err) {
        console.error('[complete] team email send failed:', err instanceof Error ? err.message : err)
      }
    }

    return res
  } catch (err) {
    console.error('[complete] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not finish creating your account. Please try again.' }, { status: 500 })
  }
}
