import { NextResponse } from 'next/server'
import { getLocationLink } from '../../../../lib/locations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/locations/{slug} — PUBLIC (no auth). Resolves a restaurant-portal
// "Links" share slug to its locations + Disco ordering pages.
// Returns { title, image, locations: [{ restaurantReference, businessName, address, slug }] }
// or 404 when the slug isn't a live locations page.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const link = await getLocationLink(slug)
  if (!link) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(link)
}
