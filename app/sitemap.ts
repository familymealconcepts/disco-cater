import type { MetadataRoute } from 'next'
import { getMarketplaceRestaurants } from '../lib/marketplace-restaurants'

const SITE = 'https://www.discocater.com'

// Forced dynamic: without this, Next statically generates sitemap.xml once at
// build time (confirmed via `npm run build` — it showed up as ○ Static). An
// archived (or newly visible) restaurant would then stay/miss from the crawl
// until the next deploy — the only real cache-staleness gap found when
// scoping archive, since every other discovery surface here reads Neon fresh
// on every request already. Deploys are frequent, but there's no reason to
// accept even that window when this route is cheap.
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // Every restaurant with a usable slug that's actually visible on the public
  // marketplace today — same visibility rule as /api/restaurants (the fullmap
  // feed), so the sitemap never lists a restaurant page that 404s or a hidden
  // one. Shared via lib/marketplace-restaurants.ts. Defensive on errors — a
  // transient DB failure shouldn't 500 the sitemap and tank crawl.
  let restaurantSlugs: { slug: string }[] = []
  try {
    const rows = await getMarketplaceRestaurants()
    restaurantSlugs = rows.filter((r) => !!r.slug).map((r) => ({ slug: r.slug as string }))
  } catch {
    restaurantSlugs = []
  }

  const staticEntries: MetadataRoute.Sitemap = [
    { url: SITE, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE}/fullmap`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/faq`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE}/become-a-partner`, lastModified: now, changeFrequency: 'monthly', priority: 0.6 },
    { url: `${SITE}/privacy`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ]

  // City landing pages — priority above restaurant pages (0.7), below the
  // homepage (1.0).
  const cityEntries: MetadataRoute.Sitemap = ['new-york', 'new-jersey', 'los-angeles', 'chicago'].map(slug => ({
    url: `${SITE}/${slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }))

  // Use-case landing pages — listed now so they're crawl-ready when published.
  const useCaseEntries: MetadataRoute.Sitemap = ['corporate-catering', 'holiday-catering', 'social-catering', 'meal-prep'].map(slug => ({
    url: `${SITE}/${slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.8,
  }))

  const restaurantEntries: MetadataRoute.Sitemap = restaurantSlugs.map(r => ({
    url: `${SITE}/restaurants/${r.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.7,
  }))

  return [...staticEntries, ...cityEntries, ...useCaseEntries, ...restaurantEntries]
}
