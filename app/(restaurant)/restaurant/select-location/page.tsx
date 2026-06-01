'use client'
import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const BLUE = '#5B6FE8'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

interface Location {
  reference: string
  businessName: string
  businessNameWithoutSpaces?: string
  address?: {
    addressLine1?: string
    city?: string
    state?: string
    zipcode?: string
  }
}

/**
 * Forced location picker for multi-location SYSTEM_ADMIN / SUPER_ADMIN
 * accounts. FM needs us to PUT /api/system-admin/restaurants/current
 * before /api/orders, /api/dashboard/*, etc. return data, so without
 * a selection the rest of the portal looks broken.
 *
 * - Single location: auto-selects and routes to /restaurant/dashboard.
 * - Multiple: shows a card list. Picking one writes the cookie + the
 *   localStorage shadow then routes onward (defaults to dashboard, or
 *   whatever the ?next= query param requested).
 * - ADMIN (single-restaurant) accounts shouldn't land here — they have
 *   the restaurant baked into their JWT. We send them straight on
 *   if they somehow do.
 */
export default function SelectLocationPage() {
  // useSearchParams requires a Suspense boundary on the prerender path.
  return (
    <Suspense fallback={<div style={{ minHeight: '100svh', background: '#fafafa' }} />}>
      <SelectLocationContent />
    </Suspense>
  )
}

function SelectLocationContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const nextUrl = searchParams?.get('next') || '/restaurant/dashboard'

  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState<string | null>(null)
  const [error, setError] = useState('')

  const proceed = useCallback(async (loc: Location) => {
    setPicking(loc.reference)
    setError('')
    try {
      const res = await fetch(
        `/api/restaurant/selected-restaurant?restaurantReference=${loc.reference}`,
        { method: 'PUT', credentials: 'include' }
      )
      if (!res.ok) throw new Error('Could not select that location.')
      try {
        localStorage.setItem('selectedRestaurant', loc.reference)
        localStorage.setItem('selectedRestaurantName', loc.businessName)
      } catch {}
      router.push(nextUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not select that location.')
      setPicking(null)
    }
  }, [router, nextUrl])

  useEffect(() => {
    let alive = true
    fetch('/api/restaurant/locations?size=1000', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { content?: Location[] }) => {
        if (!alive) return
        const list = Array.isArray(d.content) ? d.content : []
        // Single location → auto-pick and bounce immediately. Avoids the
        // "click your only choice" UX entirely.
        if (list.length === 1) { proceed(list[0]); return }
        setLocations(list)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError('Could not load your locations. Try again.')
        setLoading(false)
      })
    return () => { alive = false }
  }, [proceed])

  const q = search.trim().toLowerCase()
  const filtered = q
    ? locations.filter(l => {
        const blob = `${l.businessName} ${l.address?.addressLine1 || ''} ${l.address?.city || ''} ${l.address?.state || ''}`.toLowerCase()
        return blob.includes(q)
      })
    : locations

  return (
    <div style={{ minHeight: '100svh', background: '#fafafa', fontFamily: F, padding: '40px 20px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .loc-card:hover { border-color: ${INDIGO} !important; box-shadow: 0 4px 16px rgba(107,110,249,0.10) !important; }
        @keyframes loc-spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ display: 'inline-flex', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
            <span style={{ background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
            <span style={{ color: '#999' }}>&nbsp;cater</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 1.5 }}>RESTAURANT PORTAL</div>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px', textAlign: 'center', letterSpacing: '-0.01em' }}>
          Select a location to continue
        </h1>
        <p style={{ fontSize: 13, color: '#888', textAlign: 'center', margin: '0 0 24px' }}>
          You manage multiple locations — pick one to load its orders, menus, and reporting.
        </p>

        {error && (
          <div style={{ background: '#fff3f3', color: '#c00', padding: '10px 14px', borderRadius: 10, marginBottom: 14, fontSize: 13, textAlign: 'center' }}>
            {error}
          </div>
        )}

        {/* Search — only show if we have enough locations to need it */}
        {!loading && locations.length > 6 && (
          <div style={{ marginBottom: 14 }}>
            <input
              type="text"
              placeholder="Search locations…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', padding: '11px 14px', border: '1.5px solid #e0e0e0',
                borderRadius: 10, fontSize: 14, fontFamily: F, color: DARK,
                outline: 'none', background: '#fff',
              }}
            />
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#888' }}>
            <div style={{ display: 'inline-block', width: 26, height: 26, borderRadius: '50%', border: `3px solid #e8e8e8`, borderTopColor: INDIGO, animation: 'loc-spin 0.85s linear infinite' }} />
            <div style={{ marginTop: 12, fontSize: 13 }}>Loading your locations…</div>
          </div>
        ) : locations.length === 0 ? (
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: 12, padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>📍</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>No locations on your account</div>
            <div style={{ fontSize: 13, color: '#888' }}>Contact Disco Cater support if this seems wrong.</div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: 12, padding: '30px 24px', textAlign: 'center', fontSize: 13, color: '#888' }}>
            No locations match &quot;{search}&quot;.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtered.map(loc => {
              const isPicking = picking === loc.reference
              const addrLine = [loc.address?.addressLine1, loc.address?.city, loc.address?.state, loc.address?.zipcode]
                .filter(Boolean).join(', ')
              return (
                <button
                  key={loc.reference}
                  type="button"
                  onClick={() => proceed(loc)}
                  disabled={!!picking}
                  className="loc-card"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
                    width: '100%', padding: '16px 18px', background: '#fff', border: '1.5px solid #ebebeb',
                    borderRadius: 12, cursor: picking ? 'wait' : 'pointer', textAlign: 'left',
                    fontFamily: F, transition: 'border-color 0.15s, box-shadow 0.15s',
                    opacity: picking && !isPicking ? 0.55 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{loc.businessName}</div>
                    {addrLine && <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>{addrLine}</div>}
                  </div>
                  <div style={{ flexShrink: 0, color: isPicking ? INDIGO : '#bbb', fontSize: 18, lineHeight: 1 }}>
                    {isPicking ? '…' : '→'}
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Logout escape hatch */}
        <div style={{ textAlign: 'center', marginTop: 22 }}>
          <button
            onClick={async () => {
              await fetch('/api/restaurant-auth', { method: 'DELETE' })
              await fetch('/api/restaurant/selected-restaurant', { method: 'DELETE' })
              try {
                localStorage.removeItem('restaurant_user')
                localStorage.removeItem('selectedRestaurant')
                localStorage.removeItem('selectedRestaurantName')
              } catch {}
              router.push('/restaurant/login')
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#888', fontFamily: F, padding: 6 }}
          >
            Sign out
          </button>
        </div>
        {/* keep BLUE referenced for future polish */}
        <span style={{ display: 'none' }} aria-hidden>{BLUE}</span>
      </div>
    </div>
  )
}
