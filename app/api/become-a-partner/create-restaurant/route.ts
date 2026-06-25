import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'
import { sanitizePhone } from '../../../../lib/utils/phone'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Seed the Disco-owned Neon rows for a brand-new restaurant so it exists in our
// overrides + cache tables immediately (hidden until an admin makes it visible
// and Stripe connects). Fire-and-forget: never let a DB hiccup fail the FM
// creation that already succeeded. `discoNative` marks rows created without an
// FM record (the fallback path).
async function seedNeonRows(reference: string, name: string, slug: string, discoNative = false) {
  try {
    await sql`
      INSERT INTO disco_restaurant_overrides
        (restaurant_reference, visible, is_premium, stripe_connected)
      VALUES (${reference}, false, false, false)
      ON CONFLICT (restaurant_reference) DO NOTHING
    `
    await sql`
      INSERT INTO disco_restaurant_cache
        (restaurant_reference, name, slug, is_disco_native, is_live, cached_at)
      VALUES (${reference}, ${name}, ${slug}, ${discoNative}, false, NOW())
      ON CONFLICT (restaurant_reference) DO NOTHING
    `
  } catch (err) {
    console.error('[create-restaurant] Neon seed failed:', err instanceof Error ? err.message : err)
  }
}

// Creates the FM restaurant right after a partner registers. FM's
// POST /api/admin/restaurants requires SUPER_ADMIN, so we authenticate with the
// service account (NOT the brand-new USER's token). multipart/form-data with a
// single `restaurant` part carrying the JSON body.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const restaurantName = String(body?.restaurantName || '').trim()
  const email = String(body?.email || '').trim()
  if (!restaurantName || !email) {
    return NextResponse.json({ error: 'Restaurant name and email are required.' }, { status: 400 })
  }

  const restaurant = {
    businessName: restaurantName,
    businessNameWithoutSpaces: restaurantName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    email,
    // FM requires a digits-only phone ("Phone number has wrong format" otherwise).
    phoneNumber: sanitizePhone(String(body?.phoneNumber || '')),
    categories: ['EVENT', 'OFFICE', 'HOLIDAY'],
    fulfillmentOptions: ['PICKUP', 'DELIVERY'],
    // FM provisions the restaurant ADMIN account from this block. Include the
    // password the partner chose so it becomes their portal login credential —
    // there is no separate USER registration in this flow.
    admin: {
      email,
      firstName: String(body?.firstName || ''),
      lastName: String(body?.lastName || ''),
      password: String(body?.password || ''),
    },
    address: {
      addressLine1: String(body?.addressLine1 || 'TBD'),
      city: String(body?.city || 'TBD'),
      state: String(body?.state || 'NY'),
      zipcode: String(body?.zipcode || ''),
    },
  }

  try {
    const header = await getFmServiceAuthHeader()
    const fd = new FormData()
    // `restaurant` part as application/json. Do NOT set Content-Type on the
    // fetch — the runtime sets the multipart boundary automatically.
    fd.append('restaurant', new Blob([JSON.stringify(restaurant)], { type: 'application/json' }))

    let res = await fetch(`${FM}/api/admin/restaurants`, {
      method: 'POST',
      headers: { ...header, Accept: 'application/json' },
      body: fd,
    })
    // One retry on an expired service token.
    if (res.status === 401) {
      const fresh = await getFmServiceAuthHeader(true)
      const fd2 = new FormData()
      fd2.append('restaurant', new Blob([JSON.stringify(restaurant)], { type: 'application/json' }))
      res = await fetch(`${FM}/api/admin/restaurants`, {
        method: 'POST',
        headers: { ...fresh, Accept: 'application/json' },
        body: fd2,
      })
    }

    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.reference) {
      const raw = JSON.stringify(data) || ''
      console.error(`[create-restaurant] FM ${res.status}:`, raw.slice(0, 400))
      // FM 400-027 = an admin with this email already exists. Surface the code so
      // the client can route the partner to the restaurant login instead. (Don't
      // fall back to a native account — the email genuinely collides.)
      if (data?.code === '400-027' || raw.includes('400-027')) {
        return NextResponse.json(
          { error: 'An account with this email already exists.', code: '400-027' },
          { status: 409 }
        )
      }
      // FM failed for another reason → DISCO-NATIVE FALLBACK. Mint a reference and
      // seed Neon as a disco-native restaurant so the partner can still complete
      // the entire flow (profile → Stripe → menu → go-live) with no FM record.
      const nativeRef = randomUUID()
      try { await runMigrations() } catch { /* seed still attempted below */ }
      await seedNeonRows(nativeRef, restaurantName, restaurant.businessNameWithoutSpaces, true)
      console.warn(`[create-restaurant] FM unavailable — created disco-native restaurant ${nativeRef} for ${email}`)
      return NextResponse.json({
        restaurantReference: nativeRef,
        adminReference: null,
        businessNameWithoutSpaces: restaurant.businessNameWithoutSpaces,
        discoNative: true,
      })
    }

    // Seed our Neon overrides + cache rows. Awaited so it completes before the
    // lambda freezes, but wrapped so a failure never blocks the response.
    await seedNeonRows(data.reference, restaurantName, restaurant.businessNameWithoutSpaces)

    return NextResponse.json({
      restaurantReference: data.reference,
      adminReference: data?.admin?.reference || null,
      businessNameWithoutSpaces: restaurant.businessNameWithoutSpaces,
    })
  } catch (err) {
    console.error('[create-restaurant] request failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'Could not create the restaurant. Please contact concierge@discocater.com.' },
      { status: 500 }
    )
  }
}
