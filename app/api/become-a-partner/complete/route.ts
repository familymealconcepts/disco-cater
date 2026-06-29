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

const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
// Prefer a dedicated partner webhook; otherwise reuse the new-order webhook so
// signups still reach Slack (with a distinct message so they're not mistaken
// for orders).
const SLACK_WEBHOOK_URL = process.env.SLACK_PARTNER_WEBHOOK_URL || process.env.SLACK_NEW_ORDER_WEBHOOK_URL
const TEAM_EMAIL = 'concierge@discocater.com'

// Server-side geocode (address → lat/lng) via the Google Geocoding API. Returns
// null on any failure so onboarding never blocks on geocoding.
async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY
  if (!key || !address) return null
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`)
    const data = await res.json().catch(() => null)
    const loc = data?.results?.[0]?.geometry?.location
    if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
      return { lat: Number(loc.lat), lng: Number(loc.lng) }
    }
  } catch (err) {
    console.error('[complete] geocode failed:', err instanceof Error ? err.message : err)
  }
  return null
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

    if (existing) {
      await sql`
        UPDATE disco_restaurant_accounts
        SET first_name = COALESCE(NULLIF(${firstName}, ''), first_name),
            last_name = COALESCE(NULLIF(${lastName}, ''), last_name),
            phone = COALESCE(NULLIF(${phone}, ''), phone),
            restaurant_name = ${restaurantName},
            business_name = ${restaurantName},
            address = ${address || null},
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
          email, password_hash, restaurant_reference, first_name, last_name, phone,
          restaurant_name, business_name, address, role, is_disco_native, onboarding_step
        ) VALUES (
          ${email}, ${passwordHash}, ${ref}, ${firstName || null}, ${lastName || null},
          ${phone || null}, ${restaurantName}, ${restaurantName}, ${address || null}, 'ADMIN', true, 4
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
        await sql`
          UPDATE disco_restaurant_accounts
          SET fm_user_reference = COALESCE(fm_user_reference, ${fm.adminReference})
          WHERE email = ${email}
        `
      } else {
        console.warn('[complete] FM creation skipped/failed (continuing):', fm.code || fm.status, fm.error)
      }
    } catch (err) {
      console.error('[complete] FM creation threw (continuing):', err instanceof Error ? err.message : err)
    }

    // ── 4) Upsert the marketplace cache row and flip it live ───────────────────
    const coords = address ? await geocode(address) : null
    await sql`
      INSERT INTO disco_restaurant_cache
        (restaurant_reference, name, slug, address, location, lat, lng, cuisine, phone, image_url, is_disco_native, is_live, cached_at)
      VALUES (${ref}, ${restaurantName}, ${slug}, ${address || null}, ${location || null},
              ${coords?.lat ?? null}, ${coords?.lng ?? null}, ${'Other'}, ${phone || null}, ${logoUrl},
              true, true, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        name = EXCLUDED.name,
        slug = COALESCE(EXCLUDED.slug, disco_restaurant_cache.slug),
        address = EXCLUDED.address,
        location = EXCLUDED.location,
        lat = COALESCE(EXCLUDED.lat, disco_restaurant_cache.lat),
        lng = COALESCE(EXCLUDED.lng, disco_restaurant_cache.lng),
        phone = EXCLUDED.phone,
        image_url = COALESCE(EXCLUDED.image_url, disco_restaurant_cache.image_url),
        is_disco_native = true,
        is_live = true,
        cached_at = NOW()
    `
    // Ensure an overrides row exists (visibility is admin-controlled; default false).
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, is_premium, stripe_connected)
      VALUES (${ref}, false, false, ${stripeConnected})
      ON CONFLICT (restaurant_reference) DO UPDATE SET stripe_connected = ${stripeConnected}
    `

    // Record the submitted menu reference (best-effort) for the super admin.
    if (menuFileName) {
      try {
        await sql`UPDATE disco_restaurant_cache SET menu_upload_url = ${menuFileName} WHERE restaurant_reference = ${ref}`
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
        <p style="margin:0 0 12px;">Congratulations${firstName ? `, ${firstName}` : ''} — <strong>${restaurantName}</strong> is now set up on Disco Cater and ready to receive catering orders.</p>
        <p style="margin:0 0 12px;">Manage your orders, menu, and settings from your restaurant portal.</p>
        ${button('Go to your dashboard', 'https://www.discocater.com/restaurant/orders')}
      `
      await sendEmail({ to: email, subject: `Welcome to Disco Cater!`, html: layout(content) })
    } catch (err) {
      console.error('[complete] welcome email failed:', err instanceof Error ? err.message : err)
    }

    // Team email notification (best-effort).
    if (MAILGUN_API_KEY && MAILGUN_DOMAIN) {
      const lines = [
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
      ].filter(Boolean).join('\n')
      try {
        const mg = new FormData()
        mg.append('from', `Disco Cater Onboarding <onboarding@${MAILGUN_DOMAIN}>`)
        mg.append('to', TEAM_EMAIL)
        mg.append('subject', `New Partner Onboarding Complete — ${restaurantName}`)
        mg.append('text', `A restaurant has completed Disco Cater onboarding.\n\n${lines}\n\n— Disco Cater Onboarding`)
        const mgRes = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
          body: mg,
        })
        if (!mgRes.ok) {
          const raw = await mgRes.text().catch(() => '')
          console.error(`[complete] Mailgun ${mgRes.status}: ${raw.slice(0, 300)}`)
        }
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
