import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../lib/db'

// Public restaurant feed for the fullmap. Reads ONLY Neon now: the
// disco_restaurant_cache snapshot (refreshed from FM by
// /api/admin/refresh-restaurant-cache + the daily cron) joined to Disco's
// overrides. A restaurant appears only when an admin marked it visible AND its
// Stripe Connect status is connected. No FM call here, so loads are fast —
// force-dynamic (always fresh from Neon, no ISR needed).
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await runMigrations()

    const rows = (await sql`
      SELECT c.restaurant_reference, c.name, c.slug, c.cuisine, c.description, c.image_url,
             c.lat, c.lng, c.location, c.address,
             o.is_premium, o.order_url, o.visible, o.stripe_connected, o.featured_order
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      WHERE o.visible = true AND o.stripe_connected = true
    `) as {
      restaurant_reference: string; name: string; slug: string | null; cuisine: string | null
      description: string | null; image_url: string | null; lat: string | null; lng: string | null
      location: string | null; address: string | null; is_premium: boolean | null; order_url: string | null
      visible: boolean | null; stripe_connected: boolean | null; featured_order: number | null
    }[]

    const result = rows
      .map((r) => {
        const lat = r.lat == null ? null : Number(r.lat)
        const lng = r.lng == null ? null : Number(r.lng)
        if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
        const slug = r.slug || ''
        return {
          reference: r.restaurant_reference,
          name: r.name,
          slug,
          cuisine: r.cuisine || 'Other',
          description: r.description || '',
          image: r.image_url || null,
          lat,
          lng,
          location: r.location || '',
          address: r.address || '',
          orderUrl: r.order_url || `/restaurants/${slug}`,
          isPremium: r.is_premium ?? false,
          featuredOrder: typeof r.featured_order === 'number' ? r.featured_order : null,
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
