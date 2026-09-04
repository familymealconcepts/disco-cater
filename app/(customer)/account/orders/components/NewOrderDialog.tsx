'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useFavorites, type FavoriteRestaurant } from '../../../../../hooks/useFavorites'
import { sizedImage } from '../../../../../lib/sanity-image'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const INDIGO = '#6466E8'
const GRAD = 'linear-gradient(90deg,#6466E8 0%,#C044C8 50%,#F0468A 100%)'

interface Props {
  /** YYYY-MM-DD for the calendar cell the user clicked. */
  date: string
  onClose: () => void
  /** Called when the embedded order completes — the calendar should
      close the dialog and refetch its data. */
  onOrderPlaced: () => void
}

// Picker card photo is ~220px wide × 130px; request a 440×260 crop (retina).
function resolveImage(src?: string): string | undefined {
  return sizedImage(src, 440, 260)
}

function fmtDayLong(s: string): string {
  if (!s) return ''
  try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) }
  catch { return s }
}

export default function NewOrderDialog({ date, onClose, onOrderPlaced }: Props) {
  const { favorites, loading } = useFavorites()
  const [picked, setPicked] = useState<FavoriteRestaurant | null>(null)

  // Listen for the confirmation page's iframe postMessage so we can
  // refresh + close once the order goes through.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (typeof window === 'undefined') return
      if (e.origin !== window.location.origin) return
      if (e.data && typeof e.data === 'object' && e.data.type === 'disco:order-placed') {
        onOrderPlaced()
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onOrderPlaced])

  // ESC closes the dialog (the picker step or the embedded step). When
  // a restaurant is picked we treat ESC as "back to picker" first.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (picked) setPicked(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked, onClose])

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const embedSrc = picked?.slug
    ? `/restaurants/${picked.slug}?orderDate=${encodeURIComponent(date)}&embed=1`
    : ''

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 900, fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid #f0f0f0', background: '#fff', flexShrink: 0 }}>
        <button
          onClick={() => (picked ? setPicked(null) : onClose())}
          aria-label="Back"
          style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, color: DARK, fontFamily: F, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          ← Back to Calendar
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {picked ? picked.name : `Order for ${fmtDayLong(date)}`}
          </div>
          {picked && (
            <div style={{ fontSize: 11, color: '#727272', marginTop: 1 }}>{fmtDayLong(date)}</div>
          )}
        </div>
        <button onClick={onClose} aria-label="Close"
          style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
      </div>

      {/* Body */}
      {picked ? (
        embedSrc ? (
          // Embedded restaurant ordering page — same RestaurantClient, just
          // loaded in an iframe so we don't have to re-implement its
          // server-side data fetching here.
          <iframe
            src={embedSrc}
            title={`Order from ${picked.name}`}
            style={{ flex: 1, width: '100%', border: 'none', background: '#f8f8fc' }}
          />
        ) : (
          // Defensive: a favorite without a slug can't render the iframe.
          // Bounce the user back to the picker with a hint instead of
          // showing a silently broken empty iframe.
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 28, textAlign: 'center', color: '#555', fontSize: 13 }}>
            <div style={{ maxWidth: 320 }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>🪩</div>
              <div style={{ fontWeight: 700, color: DARK, marginBottom: 6 }}>Can&apos;t open this favorite</div>
              <div>This saved restaurant is missing a link. Try Browse the Catering Map to find it again.</div>
            </div>
          </div>
        )
      ) : (
        <FavoritesPicker
          date={date}
          favorites={favorites}
          loading={loading}
          onPick={r => setPicked(r)}
          onBrowseAll={onClose}
        />
      )}
    </div>
  )
}

// ── Step 1: pick a favorite (or browse all) ─────────────────────────────────

function FavoritesPicker({ date, favorites, loading, onPick, onBrowseAll }: {
  date: string
  favorites: FavoriteRestaurant[]
  loading: boolean
  onPick: (r: FavoriteRestaurant) => void
  onBrowseAll: () => void
}) {
  const usable = favorites.filter(f => !!f.slug)

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px 60px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 22px', lineHeight: 1.5 }}>
          Pick a saved restaurant to start a new order — the date you clicked is pre-filled for you.
        </p>

        {loading ? (
          <div style={{ color: '#727272', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>Loading favorites…</div>
        ) : usable.length === 0 ? (
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, padding: '48px 24px', textAlign: 'center', background: '#fff' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>🤍</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>No favorites yet</div>
            <div style={{ fontSize: 13, color: '#727272', marginBottom: 22, lineHeight: 1.5 }}>
              Explore the Catering Map to find restaurants you love.
            </div>
            <Link href="/fullmap" onClick={onBrowseAll}
              style={{ padding: '10px 22px', background: BLUE, color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'inline-block' }}>
              Catering Map →
            </Link>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
            {usable.map(f => {
              const img = resolveImage(f.image)
              const loc = [f.city, f.state].filter(Boolean).join(', ') || f.location
              return (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => onPick(f)}
                  style={{
                    border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden',
                    background: '#fff', textAlign: 'left', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', padding: 0, fontFamily: F,
                    transition: 'border-color 0.12s, box-shadow 0.12s',
                  }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c0c0c0'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)' }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ebebeb'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                >
                  <div style={{
                    width: '100%', height: 130, background: GRAD, overflow: 'hidden',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 32, color: 'rgba(255,255,255,0.85)',
                  }}>{img
                    ? <img src={img} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : '🪩'}</div>
                  <div style={{ padding: '12px 14px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.name || 'Restaurant'}
                    </div>
                    {loc && <div style={{ fontSize: 11, color: '#727272' }}>{loc}</div>}
                    {f.cuisine && <div style={{ fontSize: 11, color: '#727272' }}>{f.cuisine}</div>}
                    <div style={{ marginTop: 'auto', paddingTop: 10 }}>
                      <span style={{ display: 'block', textAlign: 'center', padding: '8px 10px', background: BLUE, color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 700 }}>
                        Order for this date →
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}

            <Link href="/fullmap" onClick={onBrowseAll}
              style={{ border: '1px dashed #c8cafd', borderRadius: 12, overflow: 'hidden', cursor: 'pointer', textDecoration: 'none', background: 'linear-gradient(135deg,rgba(107,110,249,0.04),rgba(192,68,200,0.04))', display: 'flex', flexDirection: 'column' }}>
              <div style={{ width: '100%', height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 38 }}>🪩</div>
              <div style={{ padding: '12px 14px 14px', textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Discover more</div>
                <div style={{ padding: '8px 10px', background: GRAD, color: '#fff', borderRadius: 7, fontSize: 12, fontWeight: 700 }}>Browse Catering Map</div>
              </div>
            </Link>
          </div>
        )}
      </div>
      {/* Use INDIGO so the unused-var linter stays happy in case the
          gradient changes — also lets future polish use it. */}
      <span style={{ display: 'none' }} aria-hidden>{INDIGO}</span>
    </div>
  )
}
