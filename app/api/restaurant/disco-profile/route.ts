import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native restaurant profile (name / address / phone / logo) — stored in
// disco_restaurant_accounts + disco_restaurant_cache during onboarding. The
// portal reads/edits it here. We NEVER sync these back to FM.

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
  } catch { /* best-effort */ }
  return null
}

// Resolve the restaurant_reference for the current request: Disco-native session
// carries it directly; FM-token users have it decoded from the JWT.
async function resolveRef(): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null
  if (ctx.restaurantReference) return ctx.restaurantReference
  return await getRestaurantRef()
}

export async function GET() {
  const ref = await resolveRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const acct = (await sql`
      SELECT restaurant_name, business_name, phone, address
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} ORDER BY id ASC LIMIT 1
    `) as { restaurant_name: string | null; business_name: string | null; phone: string | null; address: string | null }[]
    const cache = (await sql`
      SELECT name, phone, address, image_url, icon_url
      FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { name: string | null; phone: string | null; address: string | null; image_url: string | null; icon_url: string | null }[]
    const a = acct[0] || {}
    const c = cache[0] || {}
    return NextResponse.json({
      restaurantName: a.restaurant_name || a.business_name || c.name || '',
      phone: a.phone || c.phone || '',
      address: a.address || c.address || '',
      logoUrl: c.image_url || '', // Marketplace Image
      iconUrl: c.icon_url || '',  // Logo
    })
  } catch (err) {
    console.error('[restaurant/disco-profile] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  const ref = await resolveRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const restaurantName = String(body?.restaurantName || '').trim()
    const phone = String(body?.phone || '').trim()
    const address = String(body?.address || '').trim()
    // Images are optional — only touched when explicitly provided.
    // logoUrl = Marketplace Image (image_url); iconUrl = Logo (icon_url).
    const logoUrl = body?.logoUrl != null ? String(body.logoUrl).trim() : undefined
    const iconUrl = body?.iconUrl != null ? String(body.iconUrl).trim() : undefined

    await runMigrations()

    // disco_restaurant_accounts (Disco-native). Best-effort: a 0-row update just
    // means this restaurant is FM-only with no Disco account row.
    await sql`
      UPDATE disco_restaurant_accounts SET
        restaurant_name = COALESCE(NULLIF(${restaurantName}, ''), restaurant_name),
        business_name = COALESCE(NULLIF(${restaurantName}, ''), business_name),
        phone = ${phone || null},
        address = ${address || null},
        updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `

    // disco_restaurant_cache (drives the marketplace listing). Re-geocode when the
    // address is present so the map pin stays accurate.
    const coords = address ? await geocode(address) : null
    await sql`
      UPDATE disco_restaurant_cache SET
        name = COALESCE(NULLIF(${restaurantName}, ''), name),
        phone = ${phone || null},
        address = ${address || null},
        lat = COALESCE(${coords?.lat ?? null}, lat),
        lng = COALESCE(${coords?.lng ?? null}, lng),
        cached_at = NOW()
      WHERE restaurant_reference = ${ref}
    `
    // Marketplace Image (image_url) — only when explicitly provided.
    if (logoUrl !== undefined) {
      await sql`
        UPDATE disco_restaurant_cache SET image_url = ${logoUrl || null}, cached_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
    }
    // Logo (icon_url) — only when explicitly provided.
    if (iconUrl !== undefined) {
      await sql`
        UPDATE disco_restaurant_cache SET icon_url = ${iconUrl || null}, cached_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[restaurant/disco-profile] PUT failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to update profile' }, { status: 500 })
  }
}
