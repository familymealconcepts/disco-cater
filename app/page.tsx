'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

export default function HomePage() {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!address.trim()) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`,
        { headers: { 'Accept-Language': 'en' } }
      )
      const data = await res.json()
      if (data && data[0]) {
        router.push(`/fullmap?lat=${data[0].lat}&lng=${data[0].lon}`)
      } else {
        setError('Address not found. Try a city, zip, or full address.')
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
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
          color: #444;
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: color 0.15s;
        }
        .nav-links a:hover { color: #6B6EF9; }

        .search-wrap {
          display: flex;
          align-items: center;
          border: 2px solid #111;
          border-radius: 14px;
          overflow: hidden;
          background: #fff;
          width: 460px;
          max-width: calc(100vw - 48px);
        }
        .search-wrap:focus-within {
          border-color: #6B6EF9;
          box-shadow: 0 0 0 3px rgba(107,110,249,0.12);
        }
        .search-input {
          flex: 1;
          padding: 14px 12px 14px 4px;
          font-size: 15px;
          border: none;
          outline: none;
          background: transparent;
          color: #111;
          font-family: 'DM Sans', sans-serif;
        }
        .search-input::placeholder { color: #bbb; }
        .search-btn {
          padding: 0 24px;
          height: 52px;
          border: none;
          cursor: pointer;
          background: #111;
          color: #fff;
          font-size: 13px;
          font-weight: 700;
          font-family: 'DM Sans', sans-serif;
          flex-shrink: 0;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .search-btn:hover { background: #6B6EF9; }
        .search-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        @media (max-width: 768px) {
          nav { padding: 14px 20px !important; }
          .nav-links { gap: 20px !important; }
        }
      `}</style>

      <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#fff', color: '#111', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* ── Nav — links top right only ── */}
        <nav style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '18px 40px',
          borderBottom: '1px solid #f0f0f0',
          position: 'sticky',
          top: 0,
          background: '#fff',
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
        }}>
          {/* Logo */}
          <div style={{ marginBottom: 24 }}>
            <Image
              src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=400w"
              alt="Disco Cater"
              width={300}
              height={78}
              style={{ objectFit: 'contain', display: 'block' }}
            />
          </div>

          {/* Tagline */}
          <p style={{ fontSize: 16, color: '#777', marginBottom: 32, letterSpacing: '-0.01em' }}>
            Welcome to the party. 🪩
          </p>

          {/* Search */}
          <form onSubmit={handleSearch}>
            <div className="search-wrap">
              <div style={{ padding: '0 12px', color: '#bbb', flexShrink: 0 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                  <circle cx="12" cy="9" r="2.5"/>
                </svg>
              </div>
              <input
                className="search-input"
                type="text"
                value={address}
                onChange={e => setAddress(e.target.value)}
                placeholder="Enter city, neighborhood, or zip…"
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
            {error && <p style={{ color: '#F0468A', fontSize: 13, marginTop: 8, textAlign: 'center' }}>{error}</p>}
          </form>
        </main>

      </div>
    </>
  )
}