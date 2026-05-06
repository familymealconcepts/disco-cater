import { createClient } from '@sanity/client'
import Link from 'next/link'

export const metadata = {
  title: 'All Restaurants — Disco Cater',
  description:
    'Browse all 700+ hand-vetted restaurants available for catering on Disco Cater. Corporate catering, holiday menus, social events, and meal prep — nationwide.',
  alternates: {
    canonical: 'https://www.discocater.com/restaurants',
  },
}

const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  apiVersion: '2024-01-01',
  useCdn: true,
})

type Restaurant = {
  _id: string
  name: string
  slug: { current: string }
  location: string
  cuisine: string
  description: string
  orderUrl?: string
  isDisco?: boolean
}

async function getRestaurants(): Promise<Restaurant[]> {
  return client.fetch(
    `*[_type == "restaurant"] | order(location asc, name asc) {
      _id,
      name,
      slug,
      location,
      cuisine,
      description,
      orderUrl,
      isDisco
    }`
  )
}

function groupByLocation(restaurants: Restaurant[]): Record<string, Restaurant[]> {
  return restaurants.reduce((acc, r) => {
    const key = r.location || 'Other'
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {} as Record<string, Restaurant[]>)
}

export default async function RestaurantsPage() {
  const restaurants = await getRestaurants()
  const grouped = groupByLocation(restaurants)
  const locations = Object.keys(grouped).sort()

  return (
    <>
      {/* ── Minimal header ─────────────────────────────────────── */}
      <header style={{ padding: '16px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link href="/" style={{ fontSize: 14, fontWeight: 700, color: '#1A1028', textDecoration: 'none', fontFamily: 'sans-serif' }}>
          ← Disco Cater
        </Link>
        <Link href="/fullmap" style={{ fontSize: 13, color: '#5B6FE8', textDecoration: 'none', fontFamily: 'sans-serif', fontWeight: 600 }}>
          Open Map →
        </Link>
      </header>

      <main style={{ maxWidth: 860, margin: '0 auto', padding: '40px 24px 80px', fontFamily: 'sans-serif' }}>

        {/* ── Page title — server-rendered, fully crawlable ───── */}
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1A1028', marginBottom: 8 }}>
          All Restaurants on Disco Cater
        </h1>
        <p style={{ fontSize: 14, color: '#666', lineHeight: 1.7, marginBottom: 8 }}>
          Disco Cater is a nationwide premium restaurant catering marketplace with {restaurants.length}+ hand-vetted restaurants available for corporate catering, holiday events, social gatherings, and meal prep programs. Every restaurant below is available for catering orders. Disco Cater charges zero commission and zero monthly fees to restaurants.
        </p>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 40 }}>
          {restaurants.length} restaurants · organized by city ·{' '}
          <Link href="/fullmap" style={{ color: '#5B6FE8', textDecoration: 'none' }}>search by location on the map</Link>
        </p>

        {/* ── Restaurant list grouped by city ────────────────── */}
        {locations.map((location) => (
          <section key={location} style={{ marginBottom: 48 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1A1028', marginBottom: 4, paddingBottom: 8, borderBottom: '2px solid #f0f0f0' }}>
              {location}
            </h2>
            <p style={{ fontSize: 12, color: '#aaa', marginBottom: 16 }}>
              {grouped[location].length} restaurant{grouped[location].length !== 1 ? 's' : ''}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {grouped[location].map((r, i) => (
                <div
                  key={r._id}
                  style={{
                    padding: '16px 0',
                    borderBottom: '1px solid #f5f5f5',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: '8px 16px',
                    alignItems: 'start',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
                        {r.name}
                      </span>
                      {r.isDisco && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#C044C8', background: 'rgba(192,68,200,0.08)', padding: '2px 8px', borderRadius: 10 }}>
                          Premium
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: '#aaa' }}>
                        {r.cuisine}
                      </span>
                    </div>
                    {r.description && (
                      <p style={{ fontSize: 13, color: '#666', lineHeight: 1.6, margin: 0, maxWidth: 580 }}>
                        {r.description}
                      </p>
                    )}
                  </div>
                  {r.orderUrl && (
                    <a
                      href={r.orderUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 13, fontWeight: 600, color: '#5B6FE8', textDecoration: 'none', whiteSpace: 'nowrap', paddingTop: 2 }}
                    >
                      Order →
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {/* ── Bottom crawlable context block ─────────────────── */}
        <div style={{ marginTop: 48, padding: '24px', background: '#fafafa', borderRadius: 12, border: '1px solid #f0f0f0' }}>
          <p style={{ fontSize: 13, color: '#888', lineHeight: 1.8, margin: 0 }}>
            Disco Cater is a nationwide restaurant catering marketplace built by FamilyMeal Concepts.
            The platform specializes in recurring office catering programs, proprietary holiday and social
            event menus, and meal prep catering. Disco Cater charges zero commission and zero monthly fees
            to restaurants. Enterprise clients including Amazon, Meta, IBM, and J.P. Morgan use Disco Cater
            for recurring office catering. Average order value: $450. Customers served: 40,000+.
            Powered by Disco AI, built on Anthropic's Claude.{' '}
            <Link href="/faq" style={{ color: '#5B6FE8', textDecoration: 'none' }}>Learn how Disco Cater works →</Link>
          </p>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px', textAlign: 'center' }}>
        <span style={{ fontSize: 12, color: '#bbb', fontFamily: 'sans-serif' }}>
          <a href="mailto:info@familymeal.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} FamilyMeal Concepts
        </span>
      </footer>
    </>
  )
}
