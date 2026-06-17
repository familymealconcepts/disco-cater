import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { upsertLocationLinkImage, imageUrlFromRef } from '../../../../../../lib/location-links'

// PATCH .../multi-unit-links/[ref]/image — set just the image_url for a link's
// Neon mirror row. Link images now live in Vercel Blob, so the portal uploads
// the file then posts the resulting blob URL here. Accepts either a full URL
// (imageUrl — the blob URL, used as-is) or a bare FM image reference (imageRef —
// legacy, expanded to FM's CDN URL). Either field empty clears the image. The
// [ref] segment is for routing only — the row is keyed by slug.
export async function PATCH(req: NextRequest) {
  // Gate on a valid restaurant session (same as the sibling link routes).
  try { await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let slug = ''
  let rawImage = ''
  try {
    const body = await req.json()
    slug = String(body?.slug || '').trim()
    // Prefer an explicit full URL; fall back to a legacy FM ref.
    rawImage = String(body?.imageUrl || body?.imageRef || '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }
  if (!slug) return NextResponse.json({ error: 'slug is required.' }, { status: 400 })

  try {
    // imageUrlFromRef passes full URLs through and expands bare refs; '' → null.
    const imageUrl = imageUrlFromRef(rawImage)
    await upsertLocationLinkImage(slug, imageUrl)
    return NextResponse.json({ ok: true, slug, imageUrl })
  } catch (e) {
    console.error('[multi-unit-links image] upsert failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update image' }, { status: 500 })
  }
}
