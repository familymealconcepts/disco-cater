import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminAuthHeader, getAdminEmail } from '../../../../lib/admin-auth'
import { cacheSnapshot, logSettingsChange } from '../../../../lib/settings-audit'

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
    const name: string | null = body?.name ? String(body.name).trim() : null
    const lat = body?.lat === '' || body?.lat == null ? null : Number(body.lat)
    const lng = body?.lng === '' || body?.lng == null ? null : Number(body.lng)

    // Three-way image_url handling:
    //  - omitted/undefined → keep existing (the CASE falls through to image_url)
    //  - "" (explicit clear) → set NULL
    //  - non-empty string    → set that URL
    const imageProvided = body?.image_url !== undefined
    const imageUrl: string | null = body?.image_url === '' ? null : (body?.image_url != null ? String(body.image_url) : null)

    const latVal = Number.isFinite(lat as number) ? lat : null
    const lngVal = Number.isFinite(lng as number) ? lng : null

    // Attribution. These are the fields the public fullmap renders, so a bad save
    // here is customer-visible; and the upsert overwrites cuisine/description/
    // location/lat/lng unconditionally, meaning a dialog submitted with a field
    // blank silently clears it. `before` is what makes that recoverable.
    const before = await cacheSnapshot(ref)
    try {
      await logSettingsChange({
        action: 'admin_cache_update',
        restaurantReference: ref,
        actorEmail: await getAdminEmail(),
        authType: 'admin',
        before: before && {
          name: before.name, cuisine: before.cuisine, description: before.description,
          location: before.location,
          // lat/lng come back from Postgres numeric as STRINGS while `after`
          // holds numbers — normalise so a before/after diff reflects a real
          // change rather than a representation difference.
          lat: before.lat == null ? null : Number(before.lat),
          lng: before.lng == null ? null : Number(before.lng),
          image_url: before.image_url,
        },
        after: {
          // Mirrors the upsert's own COALESCE/CASE semantics: a name that wasn't
          // sent keeps the existing one, and an omitted image_url is untouched.
          name: name || before?.name || 'Restaurant',
          cuisine, description, location, lat: latVal, lng: lngVal,
          image_url: imageProvided ? imageUrl : (before?.image_url ?? null),
        },
        extra: { imageProvided, newRow: before == null },
      })
    } catch (e) {
      console.error('[restaurant-cache] audit row failed:', e instanceof Error ? e.message : e)
    }
    // UPSERT so the save never silently no-ops when the restaurant has no cache row
    // yet (e.g. an FM-backed restaurant not previously synced). A new row needs the
    // NOT NULL `name`; on conflict we keep the existing name if none was sent.
    const rows = (await sql`
      INSERT INTO disco_restaurant_cache (restaurant_reference, name, cuisine, description, location, lat, lng, image_url, cached_at)
      VALUES (${ref}, ${name || 'Restaurant'}, ${cuisine}, ${description}, ${location}, ${latVal}, ${lngVal}, ${imageProvided ? imageUrl : null}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET
        cuisine = EXCLUDED.cuisine,
        description = EXCLUDED.description,
        location = EXCLUDED.location,
        lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        name = COALESCE(${name}, disco_restaurant_cache.name),
        image_url = CASE WHEN ${imageProvided}::boolean THEN ${imageUrl}::text ELSE disco_restaurant_cache.image_url END,
        cached_at = NOW()
      RETURNING restaurant_reference
    `) as { restaurant_reference: string }[]
    return NextResponse.json({ success: true, upserted: rows.length })
  } catch (e) {
    console.error('[restaurant-cache] PATCH failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save cache row' }, { status: 500 })
  }
}
