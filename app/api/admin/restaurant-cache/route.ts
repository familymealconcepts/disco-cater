import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Read/write the Disco-owned map fields on disco_restaurant_cache (cuisine,
// description, location, lat, lng, image_url). This is the single source of
// truth the public fullmap reads — replacing the old Sanity marketplace doc.
// Admin-cookie gated.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/restaurant-cache?restaurantReference=... → current cache fields
export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const ref = req.nextUrl.searchParams.get('restaurantReference')
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

  try {
    const rows = (await sql`
      SELECT cuisine, description, location, lat, lng, image_url
      FROM disco_restaurant_cache
      WHERE restaurant_reference = ${ref}
    `) as {
      cuisine: string | null; description: string | null; location: string | null
      lat: string | null; lng: string | null; image_url: string | null
    }[]
    // Null when there's no cache row yet (the dialog treats that as empty fields).
    return NextResponse.json(rows[0] ?? null)
  } catch (e) {
    console.error('[restaurant-cache] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load cache row' }, { status: 500 })
  }
}

// PATCH /api/admin/restaurant-cache
// body { restaurantReference, cuisine, description, location, lat, lng, image_url }
// image_url uses COALESCE so passing null leaves the existing image untouched.
export async function PATCH(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    const body = await req.json().catch(() => null)
    const ref: string | undefined = body?.restaurantReference
    if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

    const cuisine: string | null = body?.cuisine ? String(body.cuisine) : null
    const description: string | null = body?.description ? String(body.description) : null
    const location: string | null = body?.location ? String(body.location) : null
    const lat = body?.lat === '' || body?.lat == null ? null : Number(body.lat)
    const lng = body?.lng === '' || body?.lng == null ? null : Number(body.lng)
    const imageUrl: string | null = body?.image_url ? String(body.image_url) : null

    await sql`
      UPDATE disco_restaurant_cache
      SET cuisine = ${cuisine},
          description = ${description},
          location = ${location},
          lat = ${Number.isFinite(lat as number) ? lat : null},
          lng = ${Number.isFinite(lng as number) ? lng : null},
          image_url = COALESCE(${imageUrl}, image_url),
          cached_at = NOW()
      WHERE restaurant_reference = ${ref}
    `
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('[restaurant-cache] PATCH failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save cache row' }, { status: 500 })
  }
}
