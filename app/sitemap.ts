import type { MetadataRoute } from 'next'
import { sql, runMigrations, withDiscoTables } from '../lib/db'

const SITE = 'https://www.discocater.com'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // Every restaurant with a usable slug that's actually visible on the public
  // marketplace today — same visibility rule as /api/restaurants (the fullmap
  // feed), so the sitemap never lists a restaurant page that 404s or a hidden
  // one. Defensive on errors — a transient DB failure shouldn't 500 the
  // sitemap and tank crawl.
  let restaurantSlugs: { slug: string }[] = []
  try {
    const rows = (await withDiscoTables(() => sql`
      SELECT c.slug
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
      WHERE c.slug IS NOT NULL
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
    `, runMigrations)) as { slug: string }[]
    restaurantSlugs = rows || []
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
