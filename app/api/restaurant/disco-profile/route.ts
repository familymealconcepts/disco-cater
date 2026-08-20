import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'

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
  // Disco: the currently-selected location (home for a single-location ADMIN);
  // FM: the JWT's restaurant. Keeps read + write on the same location for
  // multi-location SYSTEM_ADMINs.
  if (ctx.authType === 'disco') return await resolveDiscoScopeRef(ctx)
  return await getRestaurantRef()
}

export async function GET() {
  const ref = await resolveRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const cache = (await sql`
      SELECT name, phone, address, image_url, icon_url
      FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { name: string | null; phone: string | null; address: string | null; image_url: string | null; icon_url: string | null }[]
    const c = cache[0] || {}
    return NextResponse.json({
      restaurant_reference: ref,
      restaurantName: c.name || '',
      phone: c.phone || '',
      address: c.address || '',
      logoUrl: c.image_url || '', // Marketplace Image
      iconUrl: c.icon_url || '',  // Logo
    })
  } catch (err) {
    console.error('[restaurant/disco-profile] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    // The write target is the restaurant_reference the CLIENT explicitly claims
    // (the one its form was loaded for), verified against the caller's permitted
    // set — never whatever the session's CURRENT selection resolves to. That's
    // the DeCheco's bug: load Location A's profile, switch to Location B, save —
    // without this, the write silently landed on B because that's what resolveRef()
    // resolves to at save time, not what the form displayed.
    const check = await requireWritableRestaurantRef(body?.restaurant_reference)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
    const ref = check.ref
    const restaurantName = String(body?.restaurantName || '').trim()
    const phone = String(body?.phone || '').trim()
    const address = String(body?.address || '').trim()
    // Images are optional — only touched when explicitly provided.
    // logoUrl = Marketplace Image (image_url); iconUrl = Logo (icon_url).
    const logoUrl = body?.logoUrl != null ? String(body.logoUrl).trim() : undefined
    const iconUrl = body?.iconUrl != null ? String(body.iconUrl).trim() : undefined

    await runMigrations()

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
