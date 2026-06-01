import type { Metadata } from 'next'
import Link from 'next/link'
import { client } from '@/sanity/lib/client'
import GlobalHeader from '../../components/GlobalHeader'

// Shared server-rendered city landing page. The four city routes
// (/new-york, /new-jersey, /los-angeles, /chicago) are thin wrappers that pass
// their CityConfig here. No 'use client' — fully server-rendered for SEO; the
// restaurant grid is static HTML built from a server-side Sanity fetch.

const SITE = 'https://www.discocater.com'
const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export interface CityConfig {
  slug: string
  name: string
  // Case-insensitive substrings matched against Sanity `location`. NY/NJ use the
  // state suffix (", ny"/", nj") so the metro's boroughs/towns are all captured;
  // LA uses metro city names to avoid pulling in other California cities
  // (SF/San Diego); Chicago matches the city name.
  matchTerms: string[]
  intro: string
}

export const CITIES: Record<'new-york' | 'new-jersey' | 'los-angeles' | 'chicago', CityConfig> = {
  'new-york': {
    slug: 'new-york',
    name: 'New York',
    matchTerms: [', ny'],
    intro:
      'New York sets the standard. The restaurants on Disco Cater reflect that — curated for corporate teams, holiday events, and occasions that demand something better than ordinary. Delivery and pickup across Manhattan, Brooklyn, Queens, and beyond.',
  },
  'new-jersey': {
    slug: 'new-jersey',
    name: 'New Jersey',
    matchTerms: [', nj'],
    intro:
      'From Jersey City to the Shore, Disco Cater connects you with the best catering options in New Jersey. Built for office teams, family gatherings, and events that deserve restaurant-quality food — without the restaurant markup.',
  },
  'los-angeles': {
    slug: 'los-angeles',
    name: 'Los Angeles',
    matchTerms: ['los angeles', 'west hollywood', 'hollywood', 'santa monica', 'beverly hills', 'culver city', 'venice', 'studio city', 'sherman oaks', 'burbank', 'glendale', 'pasadena', 'westwood'],
    intro:
      'Los Angeles has no shortage of great food. Disco Cater curates the best of it for catering — from West Hollywood to the Westside, DTLA to the Valley. Corporate lunches, film set catering, private events, and everything in between.',
  },
  'chicago': {
    slug: 'chicago',
    name: 'Chicago',
    matchTerms: ['chicago'],
    intro:
      "Chicago takes food seriously. Disco Cater brings the city's best catering options to corporate teams, event planners, and anyone who refuses to settle for average. Delivery and pickup across the Loop, River North, Lincoln Park, and beyond.",
  },
}

interface CityRestaurant {
  _id: string
  name: string
  slug?: { current?: string }
  cuisine?: string
  cuisines?: string[]
  location?: string
  image?: string
  isDisco?: boolean
  description?: string
}

function cityDescription(name: string): string {
  return `Order catering from the best restaurants in ${name}. Corporate, holiday, and event catering — delivery and pickup available.`
}

export function buildCityMetadata(cfg: CityConfig): Metadata {
  const title = `${cfg.name} Catering | Order Local | Disco Cater`
  const description = cityDescription(cfg.name)
  const url = `${SITE}/${cfg.slug}`
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${cfg.name} Catering | Disco Cater`,
      description,
      url,
      siteName: 'Disco Cater',
      type: 'website',
    },
  }
}

async function fetchCityRestaurants(cfg: CityConfig): Promise<CityRestaurant[]> {
  let rows: CityRestaurant[] = []
  try {
    rows = await client.fetch(
      `*[_type=="restaurant" && defined(slug.current) && defined(location)]{
        _id, name, slug,
        "cuisine": coalesce(cuisines[0], cuisine),
        cuisines, location,
        "image": image.asset->url,
        isDisco, description
      }`,
    )
  } catch {
    return []
  }
  return rows
    .filter(r => {
      const loc = (r.location || '').toLowerCase()
      return cfg.matchTerms.some(t => loc.includes(t))
    })
    // Premium (Disco) first, then alphabetical — stable, deterministic order.
    .sort((a, b) => Number(!!b.isDisco) - Number(!!a.isDisco) || a.name.localeCompare(b.name))
}

const CITY_FOOTER_LINKS = [
  { slug: 'new-york', name: 'New York' },
  { slug: 'new-jersey', name: 'New Jersey' },
  { slug: 'los-angeles', name: 'Los Angeles' },
  { slug: 'chicago', name: 'Chicago' },
]

export default async function CityLanding({ city }: { city: CityConfig }) {
  const restaurants = await fetchCityRestaurants(city)
  const description = cityDescription(city.name)

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${city.name} Catering`,
    description,
    url: `${SITE}/${city.slug}`,
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <GlobalHeader />

      <main style={{ fontFamily: F, maxWidth: 1120, margin: '0 auto', padding: '40px 24px 64px', color: DARK }}>
        <h1 style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 14px', lineHeight: 1.15 }}>
          {city.name} Catering — Order from the Best Local Restaurants
        </h1>
        <p style={{ fontSize: 16, lineHeight: 1.65, color: '#585786', maxWidth: 720, margin: '0 0 36px' }}>
          {city.intro}
        </p>

        {restaurants.length === 0 ? (
          <div style={{ fontSize: 16, color: '#585786', lineHeight: 1.65 }}>
            We&apos;re expanding to {city.name} soon.{' '}
            <Link href="/fullmap" style={{ color: '#5B6FE8', fontWeight: 600, textDecoration: 'none' }}>
              Browse all restaurants on the catering map.
            </Link>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 20 }}>
            {restaurants.map(r => {
              const slug = r.slug?.current
              const href = slug ? `/restaurants/${slug}` : '/fullmap'
              const tag = (r.cuisines && r.cuisines.length > 0 ? r.cuisines[0] : r.cuisine) || ''
              return (
                <Link
                  key={r._id}
                  href={href}
                  style={{ textDecoration: 'none', color: 'inherit', border: '1px solid #eee', borderRadius: 14, overflow: 'hidden', background: '#fff', display: 'block', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}
                >
                  <div style={{ height: 150, background: '#f4f4fb', overflow: 'hidden', position: 'relative' }}>
                    {r.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt={r.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 800, color: '#fff', background: GRAD }}>
                        {(r.name?.[0] || '·').toUpperCase()}
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '13px 15px 16px' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 4, letterSpacing: '-0.01em' }}>
                      {r.name}{r.isDisco ? ' 🪩' : ''}
                    </div>
                    <div style={{ fontSize: 12.5, color: '#888' }}>
                      {[tag, r.location].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </main>

      {/* Footer — Browse by City links are plain crawlable anchors. */}
      <footer style={{ fontFamily: F, borderTop: '1px solid #f0f0f0', padding: '24px 24px 40px', maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: '#bbb' }}>Browse by City</span>
          {CITY_FOOTER_LINKS.map((c, i) => (
            <span key={c.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {i > 0 && <span style={{ fontSize: 13, color: '#ddd' }}>·</span>}
              <Link href={`/${c.slug}`} style={{ fontSize: 13, color: '#bbb', textDecoration: 'none' }}>{c.name}</Link>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <a href="mailto:concierge@discocater.com" style={{ fontSize: 13, color: '#bbb', textDecoration: 'none' }}>Contact</a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <span style={{ fontSize: 13, color: '#ccc' }}>© 2026 Disco Cater</span>
        </div>
      </footer>
    </>
  )
}
