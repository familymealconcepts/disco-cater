import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import GlobalHeader from '../../../components/GlobalHeader'
import { getLocationLink, type LocationLink } from '../../../../lib/locations'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'

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

function Landing({ link }: { link: LocationLink }) {
  return (
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <GlobalHeader />
      <main style={{ flex: 1, width: '100%', maxWidth: 680, margin: '0 auto', padding: '48px 20px 80px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: DARK, textAlign: 'center', margin: '0 0 8px', letterSpacing: '-0.01em' }}>
          Order from {link.title}
        </h1>
        <p style={{ textAlign: 'center', color: '#777', fontSize: 15, margin: '0 0 32px' }}>
          Choose a location to start your catering order.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {link.locations.map((loc, i) => (
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
      </main>
    </div>
  )
}

// ── Inactive / not-found ──────────────────────────────────────────────────────

function NotActive() {
  return (
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <GlobalHeader />
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
