import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Server-side geocode (address → lat/lng) via the Google Geocoding API. Prefers
// the server-only key, falls back to the public Maps key. Returns null on any
// failure so onboarding never blocks on geocoding.
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
    console.error('[partner/profile] geocode failed:', err instanceof Error ? err.message : err)
  }
  return null
}

// POST /api/become-a-partner/profile
// Restaurant profile step. Generates (or accepts) the restaurant_reference,
// enriches the Disco-native account, and upserts the marketplace cache row
// (geocoded, is_disco_native=true, is_live=false). Returns { restaurant_reference }.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }) }

  const businessName = String(body?.businessName || '').trim()
  if (!businessName) return NextResponse.json({ error: 'Business name is required.' }, { status: 400 })

  // Reuse the reference from account creation when present; otherwise mint one so
  // a purely Disco-native partner (no FM record) still gets a stable reference.
  const ref = String(body?.restaurantReference || '').trim() || randomUUID()

  const street = String(body?.street || '').trim()
  const city = String(body?.city || '').trim()
  const state = String(body?.state || '').trim()
  const zip = String(body?.zip || '').trim()
  const phone = String(body?.phone || '').trim()
  const cuisine = String(body?.cuisine || '').trim() || 'Other'
  const logoUrl = String(body?.logoUrl || '').trim() || null
  const address = [street, city, state, zip].filter(Boolean).join(', ')
  const location = [city, state].filter(Boolean).join(', ')
  const slug = businessName.toLowerCase().replace(/[^a-z0-9]/g, '')

  const coords = address ? await geocode(address) : null

  try {
    await runMigrations() // ensures accounts + cache onboarding columns exist

    // Enrich the Disco-native account (created by the register step). Best-effort:
    // a 0-row update just means the account isn't created yet in this path.
    // Name/phone/address live on disco_restaurant_cache below, not here.
    await sql`
      UPDATE disco_restaurant_accounts
      SET cuisine = ${cuisine},
          is_disco_native = true,
          onboarding_step = GREATEST(COALESCE(onboarding_step, 0), 1),
          updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `

    // Upsert the marketplace cache row. is_live is intentionally NOT touched on
    // conflict (preserves a super-admin toggle); it defaults false on insert.
    await sql`
      INSERT INTO disco_restaurant_cache
        (restaurant_reference, name, slug, address, location, lat, lng, cuisine, phone, image_url, is_disco_native, is_live, cached_at)
      VALUES (${ref}, ${businessName}, ${slug}, ${address || null}, ${location || null},
              ${coords?.lat ?? null}, ${coords?.lng ?? null}, ${cuisine}, ${phone || null}, ${logoUrl},
              true, false, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        name = EXCLUDED.name,
        slug = COALESCE(EXCLUDED.slug, disco_restaurant_cache.slug),
        address = EXCLUDED.address,
        location = EXCLUDED.location,
        lat = COALESCE(EXCLUDED.lat, disco_restaurant_cache.lat),
        lng = COALESCE(EXCLUDED.lng, disco_restaurant_cache.lng),
        cuisine = EXCLUDED.cuisine,
        phone = EXCLUDED.phone,
        image_url = COALESCE(EXCLUDED.image_url, disco_restaurant_cache.image_url),
        is_disco_native = true,
        cached_at = NOW()
    `

    return NextResponse.json({ restaurant_reference: ref, geocoded: !!coords })
  } catch (err) {
    console.error('[partner/profile] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not save your restaurant profile.' }, { status: 500 })
  }
}
