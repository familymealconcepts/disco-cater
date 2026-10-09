import type { MetadataRoute } from 'next'
import { getMarketplaceRestaurants } from '../lib/marketplace-restaurants'
import { sql } from '../lib/db'

const SITE = 'https://www.discocater.com'

// lastmod is each restaurant's REAL last-changed date, never the request time.
// Stamping every entry with `new Date()` (as this file used to) tells a crawler
// that all ~400 pages changed on every fetch, so it learns to ignore lastmod
// entirely — the signal is only useful if it is honest.
//
// The date is the later of:
//   • disco_restaurant_overrides.updated_at — bumped by every settings write:
//     the map toggle, online ordering, announcement, Stripe link, archive.
//   • the newest updated_at across the restaurant's disco_menus,
//     disco_menu_categories and disco_menu_items — menu edits never touch
//     overrides, and the menu is most of what the page shows.
//
// NOT disco_restaurant_cache.cached_at: the daily sync-restaurants cron rewrites
// it for every row, so it is "now" with a one-day lag — the same lie as before.
// Profile edits (name, description, image) live on the cache row and have no
// timestamp of their own, so they are not reflected here. Measured 2026-10-09
// over 424 native marketplace restaurants: 23 distinct dates, and the menu term
// is the later of the two for 22 of them.
async function getLastChanged(refs: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  if (refs.length === 0) return out
  const rows = (await sql`
    SELECT o.restaurant_reference::text AS ref,
           GREATEST(o.updated_at, m.menu_updated_at) AS last_changed
    FROM disco_restaurant_overrides o
    LEFT JOIN (
      SELECT ref, max(t) AS menu_updated_at FROM (
        SELECT restaurant_reference::text AS ref, updated_at AS t FROM disco_menus
        UNION ALL
        SELECT restaurant_reference::text, updated_at FROM disco_menu_categories
        UNION ALL
        SELECT restaurant_reference::text, updated_at FROM disco_menu_items
      ) u
      GROUP BY ref
    ) m ON m.ref = o.restaurant_reference::text
    WHERE o.restaurant_reference::text = ANY(${refs})
  `) as { ref: string; last_changed: string | Date | null }[]
  for (const r of rows) {
    if (r.last_changed) out.set(r.ref, new Date(r.last_changed))
  }
  return out
}

// Forced dynamic: without this, Next statically generates sitemap.xml once at
// build time (confirmed via `npm run build` — it showed up as ○ Static). An
// archived (or newly visible) restaurant would then stay/miss from the crawl
// until the next deploy — the only real cache-staleness gap found when
// scoping archive, since every other discovery surface here reads Neon fresh
// on every request already. Deploys are frequent, but there's no reason to
// accept even that window when this route is cheap.
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Every restaurant with a usable slug that's actually visible on the public
  // marketplace today — same visibility rule as /api/restaurants (the fullmap
  // feed), so the sitemap never lists a restaurant page that 404s or a hidden
  // one. Shared via lib/marketplace-restaurants.ts. Defensive on errors — a
  // transient DB failure shouldn't 500 the sitemap and tank crawl.
  let restaurants: { slug: string; reference: string }[] = []
  try {
    const rows = await getMarketplaceRestaurants()
    restaurants = rows.filter((r) => !!r.slug).map((r) => ({ slug: r.slug as string, reference: r.reference }))
  } catch {
    restaurants = []
  }

  // Same defensiveness for the dates: if this lookup fails, entries go out
  // without a lastmod (which a crawler treats as "unknown") rather than the
  // sitemap failing or falling back to a fake one.
  let lastChanged = new Map<string, Date>()
  try {
    lastChanged = await getLastChanged(restaurants.map((r) => r.reference))
  } catch {
    lastChanged = new Map()
  }

  // Non-restaurant pages carry NO lastmod. They have no stored change date, and
  // their content changes only on deploy; omitting the tag is honest, where any
  // value invented here would not be.
  const staticEntries: MetadataRoute.Sitemap = [
    { url: SITE, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE}/fullmap`, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/faq`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE}/become-a-partner`, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE}/terms`, changeFrequency: 'yearly', priority: 0.3 },
  ]

  // City landing pages — priority above restaurant pages (0.7), below the
  // homepage (1.0).
  const cityEntries: MetadataRoute.Sitemap = ['new-york', 'new-jersey', 'los-angeles', 'chicago'].map(slug => ({
    url: `${SITE}/${slug}`,
    changeFrequency: 'weekly',
    priority: 0.8,
  }))

  // Use-case landing pages — listed now so they're crawl-ready when published.
  const useCaseEntries: MetadataRoute.Sitemap = ['corporate-catering', 'holiday-catering', 'social-catering', 'meal-prep'].map(slug => ({
    url: `${SITE}/${slug}`,
    changeFrequency: 'weekly',
    priority: 0.8,
  }))

  // Comparison pages. Listed for crawl discovery only — deliberately NOT linked
  // from any nav, footer or page on the site.
  const compareEntries: MetadataRoute.Sitemap = ['ezcater'].map(slug => ({
    url: `${SITE}/compare/${slug}`,
    changeFrequency: 'monthly',
    priority: 0.5,
  }))

  const restaurantEntries: MetadataRoute.Sitemap = restaurants.map(r => {
    const lastModified = lastChanged.get(r.reference)
    return {
      url: `${SITE}/restaurants/${r.slug}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: 'weekly',
      priority: 0.7,
    }
  })

  return [...staticEntries, ...cityEntries, ...useCaseEntries, ...compareEntries, ...restaurantEntries]
}
