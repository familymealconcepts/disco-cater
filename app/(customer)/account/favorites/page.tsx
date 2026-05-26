'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

interface FavRestaurant {
  reference?: string
  id?: string
  name?: string
  businessName?: string
  image?: string
  cuisine?: string
  slug?: string
  businessNameWithoutSpaces?: string
}

export default function FavoritesPage() {
  const [favs, setFavs] = useState<FavRestaurant[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // FM doesn't expose a customer "favorites" list yet; until it does, we
    // read whatever the user has locally pinned and treat it as an empty list
    // by default. Discoverable: clicking "Browse Disco Cater" jumps to the map.
    try {
      const raw = localStorage.getItem('disco_favorites')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setFavs(parsed)
      }
    } catch {}
    setLoading(false)
  }, [])

  function removeFav(ref?: string) {
    if (!ref) return
    const next = favs.filter(f => (f.reference || f.id) !== ref)
    setFavs(next)
    try { localStorage.setItem('disco_favorites', JSON.stringify(next)) } catch {}
  }

  return (
    <div style={{ fontFamily: F }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 6, marginTop: 0 }}>Favorites</h1>
      <p style={{ fontSize: 12, color: '#888', margin: '0 0 22px' }}>Restaurants you've saved for easy reordering.</p>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 14 }}>
          {favs.map(f => {
            const ref = (f.reference || f.id) as string
            const name = f.name || f.businessName || 'Restaurant'
            const orderHref = f.slug
              ? `/restaurants/${f.slug}`
              : f.businessNameWithoutSpaces
              ? `/restaurants/${f.businessNameWithoutSpaces}`
              : '/fullmap'
            return (
              <div key={ref || name} style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff', position: 'relative', transition: 'border-color 0.12s, box-shadow 0.12s' }}
                onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c0c0c0'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)' }}
                onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ebebeb'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
              >
                <button onClick={() => removeFav(ref)}
                  title="Remove from favorites"
                  style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: '50%', background: 'rgba(255,255,255,0.92)', border: '1px solid #e0e0e0', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#555', cursor: 'pointer', zIndex: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex' }}>
                  ×
                </button>
                <div style={{ width: '100%', height: 110, background: f.image ? `center/cover no-repeat url(${f.image})` : '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
                  {!f.image && '🍽️'}
                </div>
                <div style={{ padding: '12px 14px 14px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{name}</div>
                  {f.cuisine && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{f.cuisine}</div>}
                  <Link href={orderHref}
                    style={{ display: 'block', textAlign: 'center', padding: '7px 10px', background: INDIGO, color: '#fff', borderRadius: 7, fontSize: 11, fontWeight: 700, marginTop: 10, textDecoration: 'none' }}>
                    Order catering
                  </Link>
                </div>
              </div>
            )
          })}

          {/* Discover tile */}
          <Link href="/fullmap"
            style={{ border: '1px dashed #c8cafd', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', textDecoration: 'none', background: 'linear-gradient(135deg,rgba(107,110,249,0.03),rgba(192,68,200,0.03))', transition: 'all 0.12s' }}
            onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = INDIGO; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(107,110,249,0.12)' }}
            onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c8cafd'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
          >
            <div style={{ width: '100%', height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34 }}>🪩</div>
            <div style={{ padding: '12px 14px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Discover more</div>
              <div style={{ padding: '6px 10px', background: GRAD, color: '#fff', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                Browse Disco Cater
              </div>
            </div>
          </Link>
        </div>
      )}
    </div>
  )
}
