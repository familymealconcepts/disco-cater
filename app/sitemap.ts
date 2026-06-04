import type { MetadataRoute } from 'next'
import { client } from '../sanity/lib/client'

const SITE = 'https://www.discocater.com'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // Pull every restaurant with a usable slug from Sanity. Defensive on errors
  // — a transient Sanity failure shouldn't 500 the sitemap and tank crawl.
  let restaurantSlugs: { slug: string }[] = []
  try {
    const rows: { slug: string }[] = await client.fetch(
      `*[_type == "restaurant" && defined(slug.current)]{ "slug": slug.current }`,
    )
    restaurantSlugs = (rows || []).filter(r => !!r.slug)
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
