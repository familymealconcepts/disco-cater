import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { getLinkImages, getLinkGradientOverrides } from '../../../../../lib/location-links'

// Returns { images: { [slug]: blobUrl } } for the requested slugs, read from the
// Neon mirror (disco_location_links). The portal links table uses this to render
// thumbnails from the source-of-truth Vercel Blob URLs instead of stale FM image
// references that no longer resolve.
//
//   GET /api/restaurant/multi-unit-links/images?slugs=a,b,c
export async function GET(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const slugs = (req.nextUrl.searchParams.get('slugs') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  const [images, gradients] = await Promise.all([getLinkImages(slugs), getLinkGradientOverrides(slugs)])
  return NextResponse.json({ images, gradients })
}
