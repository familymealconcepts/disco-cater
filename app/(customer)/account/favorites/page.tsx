'use client'
import Link from 'next/link'
import { useFavorites } from '../../../../hooks/useFavorites'
import FavoriteHeart from '../components/FavoriteHeart'
import { sizedImage } from '../../../../lib/sanity-image'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const BLUE = '#5B6FE8'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

// Card photo is ~full grid-column wide × 130px; request a 500×300 crop (retina).
function resolveImage(src?: string): string | undefined {
  return sizedImage(src, 500, 300)
}

function locationText(city?: string, state?: string, fallback?: string): string {
  if (city && state) return `${city}, ${state}`
  if (city) return city
  if (state) return state
  return fallback || ''
}

export default function FavoritesPage() {
  const { favorites, loading, error, refresh } = useFavorites()

  return (
    <div style={{ fontFamily: F }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 6, marginTop: 0 }}>Favorites</h1>
      <p style={{ fontSize: 12, color: '#888', margin: '0 0 22px' }}>Restaurants you've saved for easy reordering.</p>

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
          <style>{`@keyframes favShimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff', display: 'flex', flexDirection: 'column' }}>
              <div style={{ width: '100%', height: 130, background: 'linear-gradient(90deg,#f0f0f0 25%,#e8e8e8 50%,#f0f0f0 75%)', backgroundSize: '200% 100%', animation: 'favShimmer 1.4s infinite' }} />
              <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ height: 13, width: '70%', borderRadius: 6, background: 'linear-gradient(90deg,#f0f0f0 25%,#e8e8e8 50%,#f0f0f0 75%)', backgroundSize: '200% 100%', animation: 'favShimmer 1.4s infinite' }} />
                <div style={{ height: 10, width: '45%', borderRadius: 6, background: 'linear-gradient(90deg,#f0f0f0 25%,#e8e8e8 50%,#f0f0f0 75%)', backgroundSize: '200% 100%', animation: 'favShimmer 1.4s infinite' }} />
                <div style={{ height: 30, width: '100%', borderRadius: 7, marginTop: 6, background: 'linear-gradient(90deg,#f0f0f0 25%,#e8e8e8 50%,#f0f0f0 75%)', backgroundSize: '200% 100%', animation: 'favShimmer 1.4s infinite' }} />
              </div>
            </div>
          ))}
        </div>
      ) : error && favorites.length === 0 ? (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '64px 24px', textAlign: 'center', background: '#fff' }}>
          <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>⚠️</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>Couldn&apos;t load your favorites</div>
          <div style={{ fontSize: 14, color: '#888', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>
            Something went wrong. Please try again.
          </div>
          <button onClick={() => refresh()}
            style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            Retry
          </button>
        </div>
      ) : favorites.length === 0 ? (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '64px 24px', textAlign: 'center', background: '#fff' }}>
          <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>⭐</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>No favorites yet</div>
          <div style={{ fontSize: 14, color: '#888', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>
            Star a restaurant on the catering map to save it here for easy access.
          </div>
          <Link href="/fullmap"
            style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', borderRadius: 999, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
            Browse restaurants
          </Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
          {favorites.map(f => {
            const name = f.name || 'Restaurant'
            const img = resolveImage(f.image)
            const orderHref = f.slug ? `/restaurants/${f.slug}` : '/fullmap'
            const loc = locationText(f.city, f.state, f.location)
            return (
              <div key={f.key}
                style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff', position: 'relative', transition: 'border-color 0.12s, box-shadow 0.12s', display: 'flex', flexDirection: 'column' }}
                onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c0c0c0'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)' }}
                onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ebebeb'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
              >
                {/* Heart — top-right of photo */}
                <FavoriteHeart restaurant={f} size={18}
                  background="rgba(255,255,255,0.92)"
                  style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
                />

                {/* Photo — lazy <img> (not a CSS background) so off-screen cards
                    defer loading; GRAD shows behind it while it loads / as fallback. */}
                <div style={{
                  width: '100%', height: 130, background: GRAD, overflow: 'hidden',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 32, color: 'rgba(255,255,255,0.85)',
                }}>
                  {img
                    ? <img src={img} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : '🪩'}
                </div>

                {/* Body */}
                <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: DARK, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                  </div>
                  {loc && (
                    <div style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{loc}</div>
                  )}
                  {f.cuisine && (
                    <div style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.cuisine}</div>
                  )}
                  <Link href={orderHref}
                    style={{ marginTop: 'auto', paddingTop: 10, display: 'block' }}>
                    <span style={{ display: 'block', textAlign: 'center', padding: '8px 10px', background: BLUE, color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 700 }}>
                      Order
                    </span>
                  </Link>
                </div>
              </div>
            )
          })}

          {/* Discover tile — always present so the grid never looks empty after a removal */}
          <Link href="/fullmap"
            style={{ border: '1px dashed #c8cafd', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', textDecoration: 'none', background: 'linear-gradient(135deg,rgba(107,110,249,0.04),rgba(192,68,200,0.04))', display: 'flex', flexDirection: 'column' }}
            onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = INDIGO; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(107,110,249,0.12)' }}
            onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c8cafd'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
          >
            <div style={{ width: '100%', height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 38 }}>🪩</div>
            <div style={{ padding: '12px 14px 14px', textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Discover more</div>
              <div style={{ padding: '8px 10px', background: GRAD, color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 700 }}>
                Browse Disco Cater
              </div>
            </div>
          </Link>
        </div>
      )}
    </div>
  )
}
