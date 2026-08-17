import { NextResponse } from 'next/server'
import { getMarketplaceRestaurants } from '../../../lib/marketplace-restaurants'

// Public restaurant feed for the fullmap. Reads ONLY Neon: the
// disco_restaurant_cache snapshot (refreshed from FM by
// /api/admin/refresh-restaurant-cache + the daily cron) joined to Disco's
// overrides. No FM call here, so loads are fast — force-dynamic (always fresh
// from Neon, no ISR needed). Visibility rule lives in
// lib/marketplace-restaurants.ts — shared with the city pages, the
// /restaurants directory, and the sitemap.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const rows = await getMarketplaceRestaurants()

    const result = rows
      .map((r) => {
        const lat = r.lat == null ? null : Number(r.lat)
        const lng = r.lng == null ? null : Number(r.lng)
        if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
        const slug = r.slug || ''
        return {
          reference: r.reference,
          name: r.name,
          slug,
          cuisine: r.cuisine || 'Other',
          description: r.description || '',
          image: r.imageUrl || null,
          lat,
          lng,
          location: r.location || '',
          address: r.address || '',
          orderUrl: r.orderUrl || `/restaurants/${slug}`,
          isPremium: r.isPremium ?? false,
          isDiscoNative: r.isDiscoNative ?? false,
          featuredOrder: typeof r.featuredOrder === 'number' ? r.featuredOrder : null,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    console.log(`[Restaurants API] Returning ${result.length} visible+stripe-connected restaurants (from cache)`)

    return NextResponse.json(result)
  } catch (e) {
    console.error('[Restaurants API] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load restaurants' }, { status: 500 })
  }
}
