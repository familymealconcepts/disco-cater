// Schema.org JSON-LD helpers for the public pages (search engines + AI answer engines).
//
// RULES: every value comes from data the page already loaded and renders. Unknown fields are
// left OUT, never guessed — no ratings, reviews, price ranges or hours are ever emitted here.
// `<` is escaped so no restaurant-supplied text can close the <script> element.

export const SITE = 'https://www.discocater.com'
export const ORG_ID = `${SITE}/#organization`

export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

export function faqPageJsonLd(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(it => ({
      '@type': 'Question',
      name: it.q,
      acceptedAnswer: { '@type': 'Answer', text: it.a },
    })),
  }
}

/** A use-case landing page (/corporate-catering etc.): the catering service Disco Cater offers. */
export function serviceJsonLd(p: { name: string; slug: string; description?: string }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: p.name,
    serviceType: 'Catering',
    url: `${SITE}/${p.slug}`,
    ...(p.description ? { description: p.description } : {}),
    provider: { '@id': ORG_ID },
    areaServed: { '@type': 'Country', name: 'United States' },
  }
}

/** A restaurant menu page. Only fields with a real value are emitted. */
export function restaurantJsonLd(p: {
  name: string
  slug: string
  address?: string | null
  description?: string | null
  cuisines?: (string | null | undefined)[]
  image?: string | null
  lat?: number | null
  lng?: number | null
}) {
  const url = `${SITE}/restaurants/${p.slug.toLowerCase()}`
  // 'Other' is the placeholder cuisine, not a cuisine — left out.
  const cuisines = (p.cuisines || []).map(c => (c || '').trim()).filter(c => c && c.toLowerCase() !== 'other')
  const hasGeo = typeof p.lat === 'number' && typeof p.lng === 'number'
    && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0)
  return {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': `${url}#restaurant`,
    name: p.name,
    url,
    hasMenu: url,
    ...(p.address?.trim() ? { address: p.address.trim() } : {}),
    ...(p.description?.trim() ? { description: p.description.trim() } : {}),
    ...(cuisines.length ? { servesCuisine: cuisines } : {}),
    ...(p.image ? { image: p.image } : {}),
    ...(hasGeo ? { geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } } : {}),
  }
}
