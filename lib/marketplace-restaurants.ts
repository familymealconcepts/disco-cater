import { sql, runMigrations, withDiscoTables } from './db'

export interface MarketplaceRestaurantRow {
  reference: string
  name: string
  slug: string | null
  cuisine: string | null
  description: string | null
  imageUrl: string | null
  lat: string | null
  lng: string | null
  location: string | null
  address: string | null
  isDiscoNative: boolean | null
  isPremium: boolean | null
  orderUrl: string | null
  featuredOrder: number | null
}

// The single source of truth for "does this restaurant appear on the public
// marketplace" — the fullmap feed, city pages, the /restaurants directory, and
// the sitemap all call this rather than each declaring their own copy of the
// same WHERE clause (which is how it was before this was extracted: the
// identical clause was independently pasted in all 4 places). The next flag
// change only needs to touch this file.
//
// VISIBILITY:
//   • archived_at IS NULL is checked FIRST and short-circuits everything below
//     it — archive is a fourth, STRONGER gate than visible/stripe_connected/
//     online_ordering_enabled, and must never be reachable around by them. See
//     lib/disco-restaurant-archive.ts for why archiving never sets those three
//     flags as a side effect (restore would become ambiguous about whether
//     `visible` was false before archiving or because of it).
//   • FM-backed: marketplace toggle ON (o.visible) AND Stripe connected
//     (o.stripe_connected). Online-ordering is NOT gated here — the Neon
//     online_ordering_enabled column is a stale default for FM-backed
//     restaurants and doesn't reflect FM's real state (a real FM
//     online-ordering mirror is a tracked follow-up).
//   • Disco-native: FULL 3-part rule — marketplace toggle ON (o.visible) AND
//     online ordering ON (COALESCE(o.online_ordering_enabled,true)) AND Stripe
//     connected (o.stripe_connected OR the Disco account finished Stripe
//     onboarding).
//
// is_live is deliberately NOT part of this filter, despite reading like it
// should be. Checked live in production: 30 of 32 disco-native restaurants
// have is_live=true (reliably maintained), but only 281 of 4,051 FM-backed
// restaurants do — the other 3,770 are is_live=false, and the FM cache-refresh
// cron (lib/restaurant-cache.ts) never touches is_live at all, so that's
// "never set," not "intentionally hidden." Adding is_live here would drop ~95
// real, currently visible+Stripe-connected FM-backed restaurants (Tap 42,
// Two Hands, Happy's Pizza, etc.) off the public feed — a regression, not a
// fix. Revisit only if is_live becomes reliably maintained for FM-backed rows.
export async function getMarketplaceRestaurants(): Promise<MarketplaceRestaurantRow[]> {
  const rows = (await withDiscoTables(() => sql`
    SELECT c.restaurant_reference, c.name, c.slug, c.cuisine, c.description,
           COALESCE(c.image_url, c.icon_url) AS image_url,
           c.lat, c.lng, c.location, c.address, c.is_disco_native,
           o.is_premium, o.order_url, o.featured_order
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
      o.archived_at IS NULL
      AND (
        (COALESCE(c.is_disco_native, false) = false
          AND o.visible = true AND o.stripe_connected = true)
        OR
        (c.is_disco_native = true
          AND o.visible = true
          AND COALESCE(o.online_ordering_enabled, true) = true
          AND (o.stripe_connected = true
               OR (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true)))
      )
  `, runMigrations)) as {
    restaurant_reference: string; name: string; slug: string | null; cuisine: string | null
    description: string | null; image_url: string | null; lat: string | null; lng: string | null
    location: string | null; address: string | null; is_disco_native: boolean | null
    is_premium: boolean | null; order_url: string | null; featured_order: number | null
  }[]

  return rows.map((r) => ({
    reference: r.restaurant_reference,
    name: r.name,
    slug: r.slug,
    cuisine: r.cuisine,
    description: r.description,
    imageUrl: r.image_url,
    lat: r.lat,
    lng: r.lng,
    location: r.location,
    address: r.address,
    isDiscoNative: r.is_disco_native,
    isPremium: r.is_premium,
    orderUrl: r.order_url,
    featuredOrder: r.featured_order,
  }))
}
