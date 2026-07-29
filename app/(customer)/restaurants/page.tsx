import Link from 'next/link'
import { sql, runMigrations, withDiscoTables } from '../../../lib/db'

export const metadata = {
  title: 'All Restaurants — Disco Cater',
  description:
    'Browse all 700+ hand-vetted restaurants available for catering on Disco Cater. Corporate catering, holiday menus, social events, and meal prep — nationwide.',
  alternates: {
    canonical: 'https://www.discocater.com/restaurants',
  },
}

type Restaurant = {
  restaurant_reference: string
  name: string
  slug: string | null
  location: string | null
  cuisine: string | null
  description: string | null
  is_premium: boolean | null
}

// Same public-marketplace visibility rule as /api/restaurants (the fullmap
// feed) and sitemap.ts — this page claims "every restaurant below is
// available for catering orders," so it must only list restaurants that
// actually are.
async function getRestaurants(): Promise<Restaurant[]> {
  return (await withDiscoTables(() => sql`
    SELECT c.restaurant_reference, c.name, c.slug, c.location, c.cuisine, c.description, o.is_premium
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
    WHERE (
      (COALESCE(c.is_disco_native, false) = false
        AND o.visible = true AND o.stripe_connected = true)
      OR
      (c.is_disco_native = true
        AND o.visible = true
        AND COALESCE(o.online_ordering_enabled, true) = true
        AND (o.stripe_connected = true
             OR (a.stripe_account_id IS NOT NULL AND a.stripe_onboarding_complete = true)))
    )
    ORDER BY c.location ASC NULLS LAST, c.name ASC
  `, runMigrations)) as Restaurant[]
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
                  key={r.restaurant_reference}
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
                      {r.is_premium && (
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
                  {r.slug && (
                    <Link
                      href={`/restaurants/${r.slug}`}
                      style={{ fontSize: 13, fontWeight: 600, color: '#5B6FE8', textDecoration: 'none', whiteSpace: 'nowrap', paddingTop: 2 }}
                    >
                      Order →
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {/* ── Bottom crawlable context block ─────────────────── */}
        <div style={{ marginTop: 48, padding: '24px', background: '#fafafa', borderRadius: 12, border: '1px solid #f0f0f0' }}>
          <p style={{ fontSize: 13, color: '#888', lineHeight: 1.8, margin: 0 }}>
            Disco Cater is a nationwide restaurant catering marketplace.
            The platform specializes in recurring office catering programs, proprietary holiday and social
            event menus, and meal prep catering. Disco Cater charges zero commission and zero monthly fees
            to restaurants. Enterprise clients including leading enterprise companies use Disco Cater
            for recurring office catering. Average order value: $450. Customers served: 40,000+.
            Powered by Disco AI, built on Anthropic's Claude.{' '}
            <Link href="/faq" style={{ color: '#5B6FE8', textDecoration: 'none' }}>Learn how Disco Cater works →</Link>
          </p>
        </div>
      </main>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer style={{ borderTop: '1px solid #f0f0f0', padding: '20px 24px', textAlign: 'center' }}>
        <span style={{ fontSize: 12, color: '#bbb', fontFamily: 'sans-serif' }}>
          <a href="mailto:concierge@discocater.com" style={{ color: '#bbb', textDecoration: 'none' }}>Contact</a>
          {' · '}© {new Date().getFullYear()} Disco Cater
        </span>
      </footer>
    </>
  )
}
