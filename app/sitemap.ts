import type { MetadataRoute } from 'next'
import { createClient } from '@sanity/client'

const SITE = 'https://www.discocater.com'

const sanity = createClient({
  projectId: '0j4eqnmw',
  dataset: 'production',
  useCdn: true,
  apiVersion: '2024-01-01',
})

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // Pull every restaurant with a usable slug from Sanity. Defensive on errors
  // — a transient Sanity failure shouldn't 500 the sitemap and tank crawl.
  let restaurantSlugs: { slug: string }[] = []
  try {
    const rows: { slug: { current?: string } | null }[] = await sanity.fetch(
      `*[_type=="restaurant" && defined(slug.current)]{ slug }`,
    )
    restaurantSlugs = rows
      .map(r => ({ slug: r.slug?.current || '' }))
      .filter(r => !!r.slug)
  } catch {
    restaurantSlugs = []
  }

  const staticEntries: MetadataRoute.Sitemap = [
    { url: SITE, lastModified: now, changeFrequency: 'daily', priority: 1.0 },
    { url: `${SITE}/fullmap`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE}/faq`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    // /new-york, /new-jersey, /los-angeles intentionally omitted — pages
    // not built yet; add back when they ship.
  ]

  const restaurantEntries: MetadataRoute.Sitemap = restaurantSlugs.map(r => ({
    url: `${SITE}/restaurants/${r.slug}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority: 0.7,
  }))

  return [...staticEntries, ...restaurantEntries]
}
