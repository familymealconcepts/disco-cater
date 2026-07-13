import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../lib/db'

// Public restaurant feed for the fullmap. Reads ONLY Neon: the
// disco_restaurant_cache snapshot (refreshed from FM by
// /api/admin/refresh-restaurant-cache + the daily cron) joined to Disco's
// overrides. No FM call here, so loads are fast — force-dynamic (always fresh
// from Neon, no ISR needed).
//
// VISIBILITY — a restaurant appears on the public marketplace when:
//   • FM-backed:    marketplace toggle ON (o.visible) AND Stripe connected
//                   (o.stripe_connected). Online-ordering is NOT gated here — the
//                   Neon online_ordering_enabled column is a stale default for
//                   FM-backed restaurants and doesn't reflect FM's real state
//                   (a real FM online-ordering mirror is a tracked follow-up).
//   • Disco-native: FULL 3-part rule — marketplace toggle ON (o.visible) AND
//                   online ordering ON (COALESCE(o.online_ordering_enabled,true))
//                   AND Stripe connected (o.stripe_connected OR the Disco account
//                   finished Stripe onboarding). This hides incomplete/test
//                   disco-native restaurants that used to surface on is_live alone.
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await runMigrations()

    const rows = (await sql`
      SELECT c.restaurant_reference, c.name, c.slug, c.cuisine, c.description, c.image_url,
             c.lat, c.lng, c.location, c.address, c.is_live, c.is_disco_native,
             o.is_premium, o.order_url, o.visible, o.stripe_connected, o.featured_order
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
      LEFT JOIN LATERAL (
        SELECT a2.stripe_account_id, a2.stripe_onboarding_complete
        FROM disco_restaurant_accounts a2
        WHERE (a2.restaurant_reference = c.restaurant_reference OR a2.fm_restaurant_reference = c.restaurant_reference)
          AND a2.stripe_account_id IS NOT NULL
        ORDER BY a2.stripe_onboarding_complete DESC NULLS LAST, a2.id ASC
        LIMIT 1
      ) a ON true
      WHERE
        (COALESCE(c.is_disco_native, false) = false
          AND o.visible = true AND o.stripe_connected = true)
        OR
        (c.is_disco_native = true
          AND o.visible = true
          AND COALESCE(o.online_ordering_enabled, true) = true
          AND (o.stripe_connected = true
               OR (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true)))
    `) as {
      restaurant_reference: string; name: string; slug: string | null; cuisine: string | null
      description: string | null; image_url: string | null; lat: string | null; lng: string | null
      location: string | null; address: string | null; is_live: boolean | null; is_disco_native: boolean | null
      is_premium: boolean | null; order_url: string | null
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
          isDiscoNative: r.is_disco_native ?? false,
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
