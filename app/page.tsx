'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || ''

declare global {
  interface Window {
    google: any
    initGooglePlaces: () => void
  }
}

export default function HomePage() {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const autocompleteRef = useRef<any>(null)

  useEffect(() => {
    if (!document.getElementById('google-maps-script')) {
      window.initGooglePlaces = initAutocomplete
      const script = document.createElement('script')
      script.id = 'google-maps-script'
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=initGooglePlaces`
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    } else if (window.google) {
      initAutocomplete()
    }
  }, [])

  function initAutocomplete() {
    if (!inputRef.current || !window.google) return

    autocompleteRef.current = new window.google.maps.places.Autocomplete(inputRef.current, {
      types: ['geocode'],
      componentRestrictions: { country: 'us' },
      fields: ['geometry', 'formatted_address'],
      // Do NOT pass bounds here — setting it later to null kills the IP/location bias
    })

    // ── Key fix: disable location bias entirely ──
    // Setting bounds to a world-spanning rectangle prevents Google from
    // prioritizing results near the user's IP or Chrome location
    const worldBounds = new window.google.maps.LatLngBounds(
      new window.google.maps.LatLng(-90, -180),
      new window.google.maps.LatLng(90, 180)
    )
    autocompleteRef.current.setBounds(worldBounds)
    // strictBounds: false means results still aren't restricted to the box,
    // but the world-spanning box neutralizes any IP/location weighting
    autocompleteRef.current.setOptions({ strictBounds: false })

    inputRef.current.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.stopPropagation()
    })

    autocompleteRef.current.addListener('place_changed', () => {
      const place = autocompleteRef.current.getPlace()
      if (place?.geometry?.location) {
        const lat = place.geometry.location.lat()
        const lng = place.geometry.location.lng()
        router.push(`/fullmap?lat=${lat}&lng=${lng}`)
      } else {
        setError('Please select a location from the dropdown.')
      }
    })
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!address.trim()) return
    setLoading(true)
    setError('')
    try {
      const geocoder = new window.google.maps.Geocoder()
      geocoder.geocode(
        { address, region: 'us' },
        (results: any, status: any) => {
          if (status === 'OK' && results[0]) {
            const lat = results[0].geometry.location.lat()
            const lng = results[0].geometry.location.lng()
            router.push(`/fullmap?lat=${lat}&lng=${lng}`)
          } else {
            setError('Address not found. Try a city, zip, or full address.')
            setLoading(false)
          }
        }
      )
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }

        .nav-links a {
          color: #555;
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: color 0.15s;
        }
        .nav-links a:hover { color: #6B6EF9; }

        /* ── Sparkle animation ── */
        .logo-wrap {
          position: relative;
          display: inline-block;
          margin-bottom: 20px;
        }
        .logo-wrap .sparkle {
          position: absolute;
          border-radius: 50%;
          pointer-events: none;
          animation: sparkle-fade 2.4s ease-in-out infinite;
          opacity: 0;
        }
        .sparkle-1 { width: 6px; height: 6px; background: #6B6EF9; top: 4px; left: 18%; animation-delay: 0s; box-shadow: 0 0 6px 2px rgba(107,110,249,0.7); }
        .sparkle-2 { width: 5px; height: 5px; background: #F0468A; top: -4px; left: 45%; animation-delay: 0.6s; box-shadow: 0 0 6px 2px rgba(240,70,138,0.7); }
        .sparkle-3 { width: 7px; height: 7px; background: #C044C8; top: 8px; right: 20%; animation-delay: 1.2s; box-shadow: 0 0 8px 3px rgba(192,68,200,0.6); }
        .sparkle-4 { width: 4px; height: 4px; background: #6B6EF9; bottom: 2px; left: 30%; animation-delay: 1.8s; box-shadow: 0 0 5px 2px rgba(107,110,249,0.6); }
        .sparkle-5 { width: 5px; height: 5px; background: #F0468A; bottom: 6px; right: 30%; animation-delay: 0.9s; box-shadow: 0 0 6px 2px rgba(240,70,138,0.6); }

        @keyframes sparkle-fade {
          0%   { opacity: 0; transform: scale(0.4) translateY(0px); }
          30%  { opacity: 1; transform: scale(1) translateY(-4px); }
          60%  { opacity: 0.6; transform: scale(0.8) translateY(-7px); }
          100% { opacity: 0; transform: scale(0.3) translateY(-10px); }
        }

        /* ── Search bar ── */
        .search-wrap {
          display: flex;
          align-items: center;
          border: 1.5px solid #e0e0e0;
          border-radius: 999px;
          overflow: hidden;
          background: #fff;
          width: 480px;
          max-width: calc(100vw - 48px);
          box-shadow: 0 2px 12px rgba(0,0,0,0.07);
          transition: box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .search-wrap:focus-within {
          border-color: #C044C8;
          box-shadow: 0 4px 20px rgba(192,68,200,0.13);
        }
        .search-input {
          flex: 1;
          padding: 15px 12px 15px 4px;
          font-size: 15px;
          border: none;
          outline: none;
          background: transparent;
          color: #111;
          font-family: 'DM Sans', sans-serif;
        }
        .search-input::placeholder { color: #bbb; }
        .search-btn {
          margin: 5px;
          padding: 0 22px;
          height: 44px;
          border: none;
          cursor: pointer;
          background: #1A1028;
          color: #fff;
          font-size: 13px;
          font-weight: 700;
          font-family: 'DM Sans', sans-serif;
          flex-shrink: 0;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          gap: 6px;
          border-radius: 999px;
        }
        .search-btn:hover { background: #6B6EF9; }
        .search-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        /* ── Google autocomplete dropdown styles ── */
        .pac-container {
          border-radius: 14px !important;
          border: 1.5px solid #e0e0e0 !important;
          box-shadow: 0 8px 24px rgba(0,0,0,0.10) !important;
          font-family: 'DM Sans', sans-serif !important;
          margin-top: 6px !important;
          overflow: hidden !important;
        }
        .pac-item {
          padding: 10px 16px !important;
          font-size: 14px !important;
          cursor: pointer !important;
          font-family: 'DM Sans', sans-serif !important;
        }
        .pac-item:hover { background: #f9f5ff !important; }
        .pac-item-selected { background: #f9f5ff !important; }
        .pac-matched { color: #6B6EF9 !important; font-weight: 600 !important; }
        .pac-icon { display: none !important; }

        @media (max-width: 768px) {
          nav { padding: 14px 20px !important; }
          .nav-links { gap: 20px !important; }
        }
      `}</style>

      <div style={{
        fontFamily: "'DM Sans', sans-serif",
        color: '#111',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'radial-gradient(ellipse at 10% 0%, rgba(107,110,249,0.07) 0%, transparent 55%), radial-gradient(ellipse at 90% 10%, rgba(240,70,138,0.06) 0%, transparent 50%), #fff',
      }}>

        {/* ── Nav ── */}
        <nav style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '18px 40px',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}>
          <div className="nav-links" style={{ display: 'flex', gap: 32 }}>
            <Link href="/fullmap">Catering Map</Link>
            <Link href="/faq">FAQ</Link>
          </div>
        </nav>

        {/* ── Centered content ── */}
        <main style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px',
          marginTop: '-40px',
        }}>
          {/* Logo with sparkles */}
          <div className="logo-wrap">
            <span className="sparkle sparkle-1" />
            <span className="sparkle sparkle-2" />
            <span className="sparkle sparkle-3" />
            <span className="sparkle sparkle-4" />
            <span className="sparkle sparkle-5" />
            <Image
              src="/disco-cater-logo.png"
              alt="Disco Cater"
              width={600}
              height={156}
              style={{ objectFit: 'contain', display: 'block' }}
            />
          </div>

          {/* Tagline */}
          <p style={{
            fontSize: 17,
            fontWeight: 500,
            color: '#444',
            marginBottom: 32,
            letterSpacing: '-0.01em',
          }}>
            Welcome to the party. 🪩
          </p>

          {/* Search */}
          <form onSubmit={handleSearch}>
            <div className="search-wrap">
              <div style={{ padding: '0 14px 0 20px', color: '#bbb', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                  <circle cx="12" cy="9" r="2.5"/>
                </svg>
              </div>
              <input
                ref={inputRef}
                className="search-input"
                type="text"
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="Enter city, neighborhood, or zip…"
                autoComplete="off"
              />
              <button className="search-btn" type="submit" disabled={loading}>
                {loading ? (
                  <span>Searching…</span>
                ) : (
                  <>
                    <span>Find Catering</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                    </svg>
                  </>
                )}
              </button>
            </div>
            {error && <p style={{ color: '#F0468A', fontSize: 13, marginTop: 10, textAlign: 'center' }}>{error}</p>}
          </form>
        </main>

        {/* ── Footer ── */}
        <footer style={{
          padding: '18px 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 24,
        }}>
          <a href="mailto:info@familymeal.com"
            style={{ fontSize: 13, color: '#bbb', textDecoration: 'none', transition: 'color 0.15s' }}
            onMouseOver={e => (e.currentTarget.style.color = '#6B6EF9')}
            onMouseOut={e => (e.currentTarget.style.color = '#bbb')}>
            Contact
          </a>
          <span style={{ fontSize: 13, color: '#ddd' }}>·</span>
          <span style={{ fontSize: 13, color: '#ccc' }}>© 2026 FamilyMeal Concepts</span>
        </footer>

      </div>
    </>
  )
}