import type { Metadata } from 'next'
import Link from 'next/link'
import { getMarketplaceRestaurants, type MarketplaceRestaurantRow } from '../../../lib/marketplace-restaurants'
import GlobalHeader from '../../components/GlobalHeader'

// Shared server-rendered city landing page. The city routes (/new-york,
// /new-jersey, /los-angeles, /chicago, /austin, /seattle) are thin wrappers that pass
// their CityConfig here. No 'use client' — fully server-rendered for SEO; the
// restaurant grid is static HTML built from a server-side Sanity fetch.

const SITE = 'https://www.discocater.com'
const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GRAD = 'linear-gradient(90deg,#6466E8 0%,#C044C8 50%,#F0468A 100%)'

export interface CityConfig {
  slug: string
  name: string
  // Case-insensitive substrings matched against Sanity `location`. NY/NJ use the
  // state suffix (", ny"/", nj") so the metro's boroughs/towns are all captured;
  // LA uses metro city names to avoid pulling in other California cities
  // (SF/San Diego); Chicago matches the city name. Austin/Seattle use
  // state-qualified metro town names (", tx"/", wa") so no other state can match.
  matchTerms: string[]
  intro: string
  // Optional FAQ. When present the page renders a visible FAQ section AND an
  // FAQPage JSON-LD block built from these same strings, so the two can't drift.
  faqs?: { q: string; a: string }[]
}

export const CITIES: Record<'new-york' | 'new-jersey' | 'los-angeles' | 'chicago' | 'austin' | 'seattle', CityConfig> = {
  'new-york': {
    slug: 'new-york',
    name: 'New York',
    matchTerms: [', ny'],
    intro:
      'New York sets the standard. The restaurants on Disco Cater reflect that — curated for corporate teams, holiday events, and occasions that demand something better than ordinary. Delivery and pickup across Manhattan, Brooklyn, Queens, and beyond.',
    faqs: [
      {
        q: 'How do I order catering in New York?',
        a: "Search your address on the Disco Cater map to see hand-vetted restaurants near you across Manhattan, Brooklyn, and beyond, then order directly from the restaurant's menu.",
      },
      {
        q: 'Can I set up recurring office catering?',
        a: 'Yes. Disco Cater is built for recurring office programs, from weekly team lunches to daily meals, with New York restaurants your team already knows.',
      },
      {
        q: 'Do you cater holiday parties?',
        a: 'Yes. Many New York restaurants on Disco Cater offer holiday and special-event menus available only on the marketplace.',
      },
      {
        q: 'How far ahead should I order?',
        a: 'Each restaurant sets its own lead time. For large groups and holiday season, order as early as you can.',
      },
      {
        q: 'Is it delivery or pickup?',
        a: 'It depends on the restaurant. Each one sets its own delivery and pickup options.',
      },
    ],
  },
  'new-jersey': {
    slug: 'new-jersey',
    name: 'New Jersey',
    matchTerms: [', nj'],
    intro:
      "Catering from New Jersey's best local restaurants, from the Jersey Shore to North Jersey. Disco Cater connects offices, event planners, and families with hand-vetted restaurants across dozens of New Jersey towns for corporate lunches, recurring office catering programs, holiday parties, and social events.",
    faqs: [
      {
        q: 'How do I order catering in New Jersey?',
        a: "Search your address on the Disco Cater map to see hand-vetted local restaurants near you, from the Jersey Shore to towns across the state, then order directly from the restaurant's menu.",
      },
      {
        q: 'Can I set up recurring office catering?',
        a: 'Yes. Offices across New Jersey use Disco Cater for recurring team lunches from restaurants close to them.',
      },
      {
        q: 'Do you cater holiday parties?',
        a: 'Yes, including holiday and special-event menus available only on Disco Cater.',
      },
      {
        q: 'How far ahead should I order?',
        a: 'Each restaurant sets its own lead time. For large groups and holiday season, order as early as you can.',
      },
      {
        q: 'Is it delivery or pickup?',
        a: 'It depends on the restaurant. Each one sets its own delivery and pickup options.',
      },
    ],
  },
  'los-angeles': {
    slug: 'los-angeles',
    name: 'Los Angeles',
    matchTerms: ['los angeles', 'west hollywood', 'hollywood', 'santa monica', 'beverly hills', 'culver city', 'venice', 'studio city', 'sherman oaks', 'burbank', 'glendale', 'pasadena', 'westwood'],
    intro:
      'Los Angeles has no shortage of great food. Disco Cater curates the best of it for catering — from West Hollywood to the Westside, DTLA to the Valley. Corporate lunches, film set catering, private events, and everything in between.',
    faqs: [
      {
        q: 'How do I order catering in Los Angeles?',
        a: "Search your address on the Disco Cater map to see hand-vetted restaurants across Los Angeles, then order directly from the restaurant's menu.",
      },
      {
        q: 'Can I set up recurring office catering?',
        a: 'Yes. Disco Cater supports recurring office programs with Los Angeles restaurants, from weekly lunches to standing orders.',
      },
      {
        q: 'Do you cater holiday parties?',
        a: 'Yes, with holiday and special-event menus available only on Disco Cater.',
      },
      {
        q: 'How far ahead should I order?',
        a: 'Each restaurant sets its own lead time. Give large orders and holiday events extra notice.',
      },
      {
        q: 'Is it delivery or pickup?',
        a: 'It depends on the restaurant. Each one sets its own delivery and pickup options.',
      },
    ],
  },
  'chicago': {
    slug: 'chicago',
    name: 'Chicago',
    matchTerms: ['chicago'],
    intro:
      "Chicago takes food seriously. Disco Cater brings the city's best catering options to corporate teams, event planners, and anyone who refuses to settle for average. Delivery and pickup across the Loop, River North, Lincoln Park, and beyond.",
  },
  // Austin and Seattle follow the METRO AREA, not the city limits: every term is
  // state-qualified (", tx"/", wa") so no other state's town can match, and
  // Dallas/Houston/San Antonio etc. stay off the Austin page. Tacoma is included
  // deliberately, as part of the Seattle–Tacoma metro. Declared after the four
  // original cities; none of their terms (", ny", ", nj", LA's bare city names,
  // "chicago") occurs in any of these ", tx"/", wa" strings, so cityForLocation's
  // first-match order cannot hand one of these locations to an earlier city.
  'austin': {
    slug: 'austin',
    name: 'Austin',
    matchTerms: ['austin, tx', 'kyle, tx', 'san marcos, tx', 'round rock, tx', 'cedar park, tx', 'pflugerville, tx', 'georgetown, tx', 'leander, tx', 'lakeway, tx', 'bee cave, tx', 'buda, tx', 'manor, tx', 'lago vista, tx'],
    intro:
      "Catering from Austin's best local restaurants. Disco Cater connects offices, event planners, and families with hand-vetted Austin restaurants for corporate lunches, recurring office catering programs, holiday parties, and social events.",
    faqs: [
      {
        q: 'How do I order catering in Austin?',
        a: "Search your Austin address on the Disco Cater map to see hand-vetted local restaurants near you, then order directly from the restaurant's menu.",
      },
      {
        q: 'Can I set up recurring office catering?',
        a: 'Yes. Austin offices can set up recurring team lunches with local restaurants on Disco Cater.',
      },
      {
        q: 'Do you cater holiday parties?',
        a: 'Yes, through restaurants offering holiday and special-event menus.',
      },
      {
        q: 'How far ahead should I order?',
        a: 'Each restaurant sets its own lead time. Order early for large groups.',
      },
      {
        q: 'Is it delivery or pickup?',
        a: 'It depends on the restaurant. Each one sets its own delivery and pickup options.',
      },
    ],
  },
  'seattle': {
    slug: 'seattle',
    name: 'Seattle',
    matchTerms: ['seattle, wa', 'bellevue, wa', 'redmond, wa', 'kirkland, wa', 'bothell, wa', 'lynnwood, wa', 'everett, wa', 'renton, wa', 'kent, wa', 'auburn, wa', 'burien, wa', 'tukwila, wa', 'federal way, wa', 'tacoma, wa', 'issaquah, wa', 'sammamish, wa', 'shoreline, wa'],
    intro:
      "Catering from Seattle's best local restaurants. Disco Cater connects offices, event planners, and families with hand-vetted Seattle restaurants for corporate lunches, recurring office catering programs, holiday parties, and social events.",
    faqs: [
      {
        q: 'How do I order catering in Seattle?',
        a: "Search your Seattle address on the Disco Cater map to see hand-vetted local restaurants near you, then order directly from the restaurant's menu.",
      },
      {
        q: 'Can I set up recurring office catering?',
        a: 'Yes. Seattle offices can set up recurring team lunches with local restaurants on Disco Cater.',
      },
      {
        q: 'Do you cater holiday parties?',
        a: 'Yes, through restaurants offering holiday and special-event menus.',
      },
      {
        q: 'How far ahead should I order?',
        a: 'Each restaurant sets its own lead time. Order early for large groups.',
      },
      {
        q: 'Is it delivery or pickup?',
        a: 'It depends on the restaurant. Each one sets its own delivery and pickup options.',
      },
    ],
  },
}

// The city page a restaurant with this `location` would be listed on, or null.
// Same substring rule fetchCityRestaurants applies below, so a link built from
// this always lands on a page that covers the restaurant's area.
export function cityForLocation(location: string | null | undefined): CityConfig | null {
  const loc = (location || '').toLowerCase()
  if (!loc) return null
  return Object.values(CITIES).find(c => c.matchTerms.some(t => loc.includes(t))) ?? null
}

interface CityRestaurant {
  restaurant_reference: string
  name: string
  slug: string | null
  cuisine: string | null
  location: string | null
  image: string | null
  is_premium: boolean | null
  description: string | null
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

// Same public-marketplace visibility rule as /api/restaurants (the fullmap
// feed) — a city page shouldn't list a restaurant that isn't actually
// orderable. Shared with the fullmap feed, the /restaurants directory, and the
// sitemap via lib/marketplace-restaurants.ts. City filtering itself stays a JS
// substring match against `location` (unchanged behavior).
async function fetchCityRestaurants(cfg: CityConfig): Promise<CityRestaurant[]> {
  let rows: MarketplaceRestaurantRow[] = []
  try {
    rows = await getMarketplaceRestaurants()
  } catch {
    return []
  }
  return rows
    .filter(r => !!r.slug && !!r.location)
    .filter(r => {
      const loc = (r.location || '').toLowerCase()
      return cfg.matchTerms.some(t => loc.includes(t))
    })
    .map((r): CityRestaurant => ({
      restaurant_reference: r.reference,
      name: r.name,
      slug: r.slug,
      cuisine: r.cuisine,
      location: r.location,
      image: r.imageUrl,
      is_premium: r.isPremium,
      description: r.description,
    }))
    // Premium (Disco) first, then alphabetical — stable, deterministic order.
    .sort((a, b) => Number(!!b.is_premium) - Number(!!a.is_premium) || a.name.localeCompare(b.name))
}

const CITY_FOOTER_LINKS = [
  { slug: 'new-york', name: 'New York' },
  { slug: 'new-jersey', name: 'New Jersey' },
  { slug: 'los-angeles', name: 'Los Angeles' },
  { slug: 'chicago', name: 'Chicago' },
  { slug: 'austin', name: 'Austin' },
  { slug: 'seattle', name: 'Seattle' },
]

// FAQPage structured data, built from the same strings the visible section
// renders. `<` is escaped so no answer text can close the <script> element.
function faqJsonLd(faqs: { q: string; a: string }[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  }).replace(/</g, '\\u003c')
}

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
      {city.faqs && city.faqs.length > 0 && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: faqJsonLd(city.faqs) }} />
      )}
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
            <Link href="/fullmap" style={{ color: '#586CE1', fontWeight: 600, textDecoration: 'none' }}>
              Browse all restaurants on the catering map.
            </Link>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 20 }}>
            {restaurants.map(r => {
              // The on-site ordering page (/restaurants/[slug]) is the correct
              // destination; the query already requires a slug.
              const href = r.slug ? `/restaurants/${r.slug}` : '/fullmap'
              const tag = (r.cuisine || '').split(',')[0]?.trim() || ''
              return (
                <Link
                  key={r.restaurant_reference}
                  href={href}
                  style={{ textDecoration: 'none', color: 'inherit', border: '1px solid #eee', borderRadius: 14, overflow: 'hidden', background: '#fff', display: 'flex', flexDirection: 'column', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}
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
                  <div style={{ padding: '13px 15px 16px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 4, letterSpacing: '-0.01em' }}>
                      {r.name}{r.is_premium ? ' 🪩' : ''}
                    </div>
                    <div style={{ fontSize: 12.5, color: '#727272' }}>
                      {[tag, r.location].filter(Boolean).join(' · ')}
                    </div>
                    {/* Visible Order CTA. The whole card already navigates via the
                        parent Link (to /restaurants/[slug] or orderUrl), so this is
                        a styled span — not a nested anchor — to avoid invalid HTML. */}
                    <span style={{ marginTop: 14, alignSelf: 'flex-start', background: GRAD, color: '#fff', fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 999 }}>
                      Order Now →
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        )}

        {/* FAQ — plain server-rendered headings + paragraphs, every answer in
            the HTML so it is indexable and matches the FAQPage JSON-LD above. */}
        {city.faqs && city.faqs.length > 0 && (
          <section style={{ marginTop: 56, maxWidth: 720 }}>
            <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 20px', lineHeight: 1.2 }}>
              {city.name} Catering FAQ
            </h2>
            {city.faqs.map(f => (
              <div key={f.q} style={{ borderTop: '1px solid #f0f0f0', padding: '16px 0' }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>{f.q}</h3>
                <p style={{ fontSize: 15, lineHeight: 1.65, color: '#585786', margin: 0 }}>{f.a}</p>
              </div>
            ))}
          </section>
        )}
      </main>

      {/* Footer — Browse by City links are plain crawlable anchors. */}
      <footer style={{ fontFamily: F, borderTop: '1px solid #f0f0f0', padding: '24px 24px 40px', maxWidth: 1120, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: '#727272' }}>Browse by City</span>
          {CITY_FOOTER_LINKS.map((c, i) => (
            <span key={c.slug} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {i > 0 && <span style={{ fontSize: 13, color: '#ddd' }}>·</span>}
              <Link href={`/${c.slug}`} style={{ fontSize: 13, color: '#727272', textDecoration: 'none' }}>{c.name}</Link>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <a href="mailto:concierge@discocater.com" style={{ fontSize: 13, color: '#727272', textDecoration: 'none' }}>Contact</a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <span style={{ fontSize: 13, color: '#ccc' }}>© 2026 Disco Cater</span>
        </div>
      </footer>
    </>
  )
}
