import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { getLocationLink, type LocationLink, type LocationItem } from '../../../../lib/locations'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
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
    const only = link.locations[0]
    redirect(only.slug ? `/restaurants/${only.slug}` : '/fullmap')
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
          minHeight: 240, // +20% (was 200)
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '48px 20px', // +20% vertical (was 40px)
          // Uploaded Link Image (image_url from Neon via resolveLinkBanner) as the
          // header background — cover/center, under a dark overlay so the title
          // stays readable. Falls back to the brand gradient when null/empty.
          background: link.image
            ? `linear-gradient(rgba(0,0,0,0.55),rgba(0,0,0,0.55)), url('${link.image}') center/cover no-repeat`
            : HERO_GRADIENT,
        }}
      >
        <h1 style={{ fontSize: 30, fontWeight: 800, color: '#fff', margin: '0 0 8px', letterSpacing: '-0.01em', textShadow: '0 2px 12px rgba(0,0,0,0.18)' }}>
          {link.title}
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.92)', fontSize: 15, margin: 0, fontWeight: 500 }}>
          Choose a location to start your catering order.
        </p>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: 680, margin: '0 auto', padding: '40px 20px 80px' }}>
        {groups.map(({ state, items }) => (
          <section key={state || '_none'} style={{ marginBottom: 32 }}>
            {state && (
              <h2 style={{ fontSize: 13, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px', paddingBottom: 8, borderBottom: '1px solid #eee' }}>
                {state}
              </h2>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                    href={loc.slug ? `/restaurants/${loc.slug}` : '/fullmap'}
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
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '48px 20px 96px' }}>
        <div style={{ fontSize: 44, lineHeight: 1, marginBottom: 18 }}>🔗</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.01em' }}>
          This link is no longer active
        </h1>
        <p style={{ fontSize: 15, color: '#777', margin: '0 0 26px', maxWidth: 380, lineHeight: 1.55 }}>
          The locations page you&apos;re looking for isn&apos;t available. Browse our marketplace to find catering near you.
        </p>
        <a
          href="/fullmap"
          style={{
            display: 'inline-block', background: BLUE, color: '#fff', textDecoration: 'none',
            padding: '12px 24px', borderRadius: 999, fontSize: 15, fontWeight: 700,
          }}
        >
          Browse restaurants →
        </a>
      </main>
    </div>
  )
}
