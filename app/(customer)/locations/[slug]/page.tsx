import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getLocationLink, type LocationLink, type LocationItem } from '../../../../lib/locations'
import NoLongerAvailable from '../../../components/NoLongerAvailable'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'

// The 1P direct order URL for a location — /order/{slug}, not /restaurants/{slug}
// (the 3P marketplace path, which carries a lead-gen fee). This Links page is a
// restaurant's own shareable link, so it must always send to the no-fee 1P
// route. /order/[slug] and /restaurants/[slug] resolve the same slug against
// the same disco_restaurant_cache row (see shared.tsx) — only the checkout fee
// path differs — so reusing loc.slug here is exactly correct. loc.slug comes
// straight from disco_restaurant_cache (lib/locations.ts) — the same table the
// detail pages themselves read. No guessed/derived slug fallback here: a
// from-name guess (lowercase, strip non-alphanumeric) reliably drops real
// hyphens in multi-word names (confirmed: "Namkeen - Union" -> "namkeenunion",
// but the real slug is "namkeen-union") and would just reintroduce the same
// class of 404 this was fixed for. A location with no cache row at all goes to
// the map instead of a likely-wrong guess.
function orderHref(loc: LocationItem): string {
  return loc.slug ? `/order/${loc.slug}` : '/fullmap'
}
// 1st-party hero gradient used when the group carries no banner image of its own.
const HERO_GRADIENT = 'linear-gradient(120deg,#6B6EF9 0%,#C044C8 52%,#F0468A 100%)'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const link = await getLocationLink(slug)
  if (!link) return { title: 'Locations — Disco Cater' }
  return {
    title: `${link.title} — Disco Cater`,
    description: `Order catering from ${link.title} on Disco Cater`,
  }
}

export default async function LocationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const link = await getLocationLink(slug)

  // Unknown / inactive slug.
  if (!link) return <NotActive />

  // Single location → go straight to its ordering page (or the map if it has no
  // Disco/Sanity page yet). redirect() must run at the top level (it throws).
  if (link.locations.length === 1) {
    redirect(orderHref(link.locations[0]))
  }

  return <Landing link={link} />
}

// ── Multi-location landing ────────────────────────────────────────────────────

// Group locations by state, sorted A→Z, each state's locations sorted by name.
// Locations with no state fall to the end under a neutral heading.
function groupByState(locations: LocationItem[]): { state: string; items: LocationItem[] }[] {
  const byState = new Map<string, LocationItem[]>()
  for (const loc of locations) {
    const key = loc.state || ''
    const list = byState.get(key) ?? []
    list.push(loc)
    byState.set(key, list)
  }
  return [...byState.entries()]
    .sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b)
    })
    .map(([state, items]) => ({
      state,
      items: items.sort((x, y) => x.businessName.localeCompare(y.businessName)),
    }))
}

function Landing({ link }: { link: LocationLink }) {
  const groups = groupByState(link.locations)
  return (
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      {/* Minimal 1st-party header: a banner hero only — no Disco logo, no
          Catering Map link, no marketplace navigation. Uses the group's own
          image when present, otherwise the brand hero gradient. */}
      <header
        style={{
          position: 'relative',
          minHeight: 312, // +30% (was 240)
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '62px 20px', // +30% vertical (was 48px)
          // Header background precedence:
          //   banner image (dark overlay for readable title)
          //   → brand gradient (manual override → auto-extracted from the
          //     restaurant's logo/marketplace image; resolved in getLocationLink)
          //   → generic Disco hero gradient.
          background: link.image
            ? `linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55)), url('${link.image}') center/cover no-repeat`
            : (link.gradient || HERO_GRADIENT),
        }}
      >
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 4rem)', fontWeight: 800, color: '#fff', margin: '0 0 8px', letterSpacing: '-0.02em', textShadow: '0 2px 8px rgba(0,0,0,0.4)', lineHeight: 1.1 }}>
          {link.title}
        </h1>
        <p style={{ color: '#fff', opacity: 0.9, fontSize: '1.1rem', margin: 0, fontWeight: 500 }}>
          Choose a location to start your catering order.
        </p>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: 960, margin: '0 auto', padding: '40px 20px 80px' }}>
        {groups.map(({ state, items }) => (
          <section key={state || '_none'} style={{ marginBottom: 32 }}>
            {state && (
              <h2 style={{ fontSize: 13, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px', paddingBottom: 8, borderBottom: '1px solid #eee' }}>
                {state}
              </h2>
            )}
            {/* Responsive grid: 3 columns on desktop, collapsing to 2 then 1 on
                narrower screens via auto-fill + a 260px floor so cards never get
                squeezed. Still grouped per-state (this grid is inside each state
                section). */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
              {items.map((loc, i) => (
                <div
                  key={loc.restaurantReference || i}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                    border: '1px solid #ececec', borderRadius: 14, background: '#fff', padding: '16px 18px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{loc.businessName}</div>
                    {loc.address && (
                      <div style={{ fontSize: 13, color: '#888', marginTop: 3 }}>{loc.address}</div>
                    )}
                  </div>
                  <a
                    href={orderHref(loc)}
                    style={{
                      flexShrink: 0, display: 'inline-block', background: BLUE, color: '#fff',
                      textDecoration: 'none', padding: '10px 20px', borderRadius: 999,
                      fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap',
                    }}
                  >
                    Order →
                  </a>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  )
}

// ── Inactive / not-found ──────────────────────────────────────────────────────

function NotActive() {
  return (
    <NoLongerAvailable
      icon="🔗"
      title="This link is no longer active"
      message="The locations page you're looking for isn't available. Browse our marketplace to find catering near you."
    />
  )
}
