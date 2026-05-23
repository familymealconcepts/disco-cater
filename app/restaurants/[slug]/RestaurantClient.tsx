'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

interface Package {
  reference: string
  name: string
  description: string
  price: number
  serves: number
  image?: string
  addOns?: any[]
}

interface Restaurant {
  name: string
  address: string
  cuisine: string
  cuisines?: string[]
  description: string
  image?: any
  orderUrl: string
  isDisco: boolean
  location: string
  tags?: string[]
}

export default function RestaurantClient({
  restaurant,
  restaurantRef,
}: {
  restaurant: Restaurant
  restaurantRef: string | null
}) {
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    if (!restaurantRef) { setLoading(false); return }
    fetch(`/api/fm-packages?ref=${restaurantRef}`)
      .then(r => r.json())
      .then(data => {
        setPackages(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [restaurantRef])

  const imageUrl = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace('image-', '').replace('-jpg', '.jpg').replace('-png', '.png').replace('-webp', '.webp')}`
    : null

  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Hero */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
          {/* Back link */}
          <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 20 }}>
            ← Back to Catering Map
          </Link>

          <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* Restaurant image */}
            <div style={{ width: 180, height: 180, borderRadius: 16, overflow: 'hidden', flexShrink: 0, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48 }}>
              {imageUrl && !imgError ? (
                <img src={imageUrl} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgError(true)} />
              ) : '🍽️'}
            </div>

            {/* Info */}
            <div style={{ flex: 1, minWidth: 240 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 20, marginBottom: 10, letterSpacing: '0.05em' }}>
                  🪩 PREMIUM
                </div>
              )}
              <h1 style={{ fontSize: 28, fontWeight: 800, color: DARK, margin: '0 0 8px', letterSpacing: '-0.03em' }}>{restaurant.name}</h1>
              <div style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>📍 {restaurant.location || restaurant.address}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                {tags.map(t => (
                  <span key={t} style={{ background: '#f0f0f0', color: '#555', fontSize: 12, padding: '3px 10px', borderRadius: 20, fontWeight: 500 }}>{t}</span>
                ))}
                {restaurant.tags?.map(t => (
                  <span key={t} style={{ background: '#EEEDFE', color: '#3C3489', fontSize: 12, padding: '3px 10px', borderRadius: 20, fontWeight: 500 }}>{t}</span>
                ))}
              </div>
              {restaurant.description && (
                <p style={{ fontSize: 14, color: '#555', lineHeight: 1.6, margin: 0, maxWidth: 480 }}>{restaurant.description}</p>
              )}
            </div>

            {/* CTA */}
            <div style={{ flexShrink: 0 }}>
              {restaurant.orderUrl ? (
                <a href={restaurant.orderUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', background: BLUE, color: '#fff', padding: '14px 28px', borderRadius: 12, fontSize: 15, fontWeight: 700, textDecoration: 'none', boxShadow: '0 4px 16px rgba(91,111,232,0.3)' }}>
                  Order Catering →
                </a>
              ) : (
                <div style={{ fontSize: 13, color: '#888', padding: '14px 0' }}>Contact restaurant to order</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Menu packages */}
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
        <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, marginBottom: 20, letterSpacing: '-0.02em' }}>
          {loading ? 'Loading menu...' : packages.length > 0 ? 'Catering Packages' : 'Menu'}
        </h2>

        {loading && (
          <div style={{ display: 'flex', gap: 16 }}>
            {[1,2,3].map(i => (
              <div key={i} style={{ flex: 1, height: 180, background: '#f0f0f0', borderRadius: 16, animation: 'pulse 1.5s infinite' }} />
            ))}
          </div>
        )}

        {!loading && packages.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {packages.map(pkg => (
              <div key={pkg.reference} style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 16, overflow: 'hidden', transition: 'all 0.15s' }}
                onMouseOver={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)'; (e.currentTarget as HTMLElement).style.borderColor = '#ddd' }}
                onMouseOut={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; (e.currentTarget as HTMLElement).style.borderColor = '#f0f0f0' }}
              >
                {pkg.image && (
                  <img src={pkg.image} alt={pkg.name} style={{ width: '100%', height: 140, objectFit: 'cover' }} />
                )}
                <div style={{ padding: 18 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 4 }}>{pkg.name}</div>
                  {pkg.serves && <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Serves {pkg.serves}</div>}
                  {pkg.description && <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: '0 0 12px' }}>{pkg.description}</p>}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: DARK }}>${(pkg.price / 100).toFixed(2)}<span style={{ fontSize: 11, fontWeight: 400, color: '#888' }}>/pp</span></div>
                    {restaurant.orderUrl && (
                      <a href={restaurant.orderUrl} target="_blank" rel="noopener noreferrer" style={{ background: BLUE, color: '#fff', padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                        Order
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && packages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#888', marginBottom: 8 }}>Menu details coming soon</div>
            <div style={{ fontSize: 14, color: '#aaa', marginBottom: 24 }}>Contact the restaurant directly to discuss catering options</div>
            {restaurant.orderUrl && (
              <a href={restaurant.orderUrl} target="_blank" rel="noopener noreferrer" style={{ background: BLUE, color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
                View on FamilyMeal →
              </a>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
      `}</style>
    </div>
  )
}
