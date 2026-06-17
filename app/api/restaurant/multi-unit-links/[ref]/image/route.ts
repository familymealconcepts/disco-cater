import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { upsertLocationLinkImage, imageUrlFromRef } from '../../../../../../lib/location-links'

// PATCH .../multi-unit-links/[ref]/image — set just the image_url for a link's
// Neon mirror row. FM's link create/update responses omit the uploaded image
// reference; the portal recovers it from FM's links listing (which DOES carry
// it) right after a save and posts it here. Body: { slug, imageRef }. The [ref]
// segment is for routing only — the row is keyed by slug.
export async function PATCH(req: NextRequest) {
  // Gate on a valid restaurant session (same as the sibling link routes).
  try { await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let slug = ''
  let imageRef = ''
  try {
    const body = await req.json()
    slug = String(body?.slug || '').trim()
    imageRef = String(body?.imageRef || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!slug) return NextResponse.json({ error: 'slug is required.' }, { status: 400 })

  try {
    const imageUrl = imageUrlFromRef(imageRef)
    await upsertLocationLinkImage(slug, imageUrl)
    return NextResponse.json({ ok: true, slug, imageUrl })
  } catch (e) {
    console.error('[multi-unit-links image] upsert failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update image' }, { status: 500 })
  }
}
