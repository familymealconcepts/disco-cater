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
        .nav-links a { color: #444; text-decoration: none; font-size: 14px; font-weight: 500; transition: color 0.15s; }
        .nav-links a:hover { color: #6B6EF9; }

        .hero { display: grid; grid-template-columns: 1fr 380px; gap: 48px; align-items: center; max-width: 1100px; margin: 0 auto; padding: 96px 48px; }
        .hero-img { width: 100%; height: 440px; object-fit: cover; object-position: center top; border-radius: 20px; display: block; box-shadow: 0 8px 40px rgba(0,0,0,0.12); }

        /* About section */
        .about { display: grid; grid-template-columns: 420px 1fr; gap: 0; align-items: stretch; border-top: 1px solid #f0f0f0; border-bottom: 1px solid #f0f0f0; padding: 64px 48px; gap: 56px; }
        .about-img { width: 100%; height: 100%; min-height: 420px; object-fit: cover; display: block; border-radius: 20px; box-shadow: 0 8px 40px rgba(0,0,0,0.10); }
        .about-text { padding: 24px 0; display: flex; flex-direction: column; justify-content: center; }

        /* Search bar */
        .search-wrap { display: flex; align-items: center; border: 2px solid #111; border-radius: 14px; overflow: hidden; background: #fff; max-width: 460px; }
        .search-wrap:focus-within { border-color: #6B6EF9; box-shadow: 0 0 0 3px rgba(107,110,249,0.12); }
        .search-input { flex: 1; padding: 14px 12px 14px 4px; font-size: 15px; border: none; outline: none; background: transparent; color: #111; font-family: 'DM Sans', sans-serif; }
        .search-input::placeholder { color: #bbb; }
        .search-btn { padding: 0 24px; height: 52px; border: none; cursor: pointer; background: #111; color: #fff; font-size: 13px; font-weight: 700; font-family: 'DM Sans', sans-serif; flex-shrink: 0; transition: all 0.15s; display: flex; align-items: center; gap: 6px; }
        .search-btn:hover { background: #6B6EF9; }
        .search-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        /* Mobile */
        @media (max-width: 768px) {
          .hero { grid-template-columns: 1fr; gap: 32px; padding: 48px 24px; }
          .hero-img { height: 260px; }
          .about { grid-template-columns: 1fr; padding: 40px 24px; gap: 32px; }
          .about-img { height: 280px; min-height: unset; }
          .about-text { padding: 0; }
          .search-wrap { max-width: 100%; }
          nav { padding: 14px 24px !important; }
          .nav-links { gap: 20px !important; }
          footer { padding: 24px !important; flex-direction: column; text-align: center; }
        }
      `}</style>

      <div style={{ fontFamily: "'DM Sans', sans-serif", background: '#fff', color: '#111', minHeight: '100vh' }}>

        {/* ── Nav (no logo on homepage — Map + FAQ only, centered) ── */}
        <nav style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px 48px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 50 }}>
          <div className="nav-links" style={{ display: 'flex', gap: 32 }}>
            <Link href="/fullmap">Maps</Link>
            <Link href="/faq">FAQ</Link>
          </div>
        </nav>

        {/* ── Hero ── */}
        <section className="hero">
          {/* Left — logo + tagline + search */}
          <div>
            {/* Logo */}
            <div style={{ marginBottom: 24 }}>
              <Image
                src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=400w"
                alt="Disco Cater"
                width={280}
                height={72}
                style={{ objectFit: 'contain', display: 'block' }}
              />
            </div>

            <p style={{ fontSize: 16, color: '#777', lineHeight: 1.7, marginBottom: 36, maxWidth: 400 }}>
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
              {error && <p style={{ color: '#F0468A', fontSize: 13, marginTop: 8 }}>{error}</p>}
            </form>
          </div>

          {/* Right — food photo */}
          <div>
            <img src="/images/hero-food.jpg" alt="Catering spread" className="hero-img" />
          </div>
        </section>

        {/* ── About — disco balls left, text right ── */}
        <section className="about">
          <div style={{ overflow: 'hidden' }}>
            <img src="/images/disco-balls.jpg" alt="Disco balls" className="about-img" />
          </div>
          <div className="about-text">
            <p style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#bbb', marginBottom: 16, margin: '0 0 16px' }}>About Us</p>
            <h2 style={{ fontSize: 'clamp(26px, 3vw, 38px)', fontWeight: 800, letterSpacing: '-1px', lineHeight: 1.2, marginBottom: 18, color: '#111' }}>
              Hi, we're Disco Cater.
            </h2>
            <p style={{ fontSize: 16, color: '#666', lineHeight: 1.8, marginBottom: 32 }}>
              We've handpicked the best catering options from top restaurants in your city to elevate your next office lunch or event.
              <br /><br />
              Welcome to the party.
            </p>
            <Link
              href="/fullmap"
              style={{
                display: 'inline-block', padding: '13px 32px', borderRadius: 100,
                background: GRADIENT, color: '#fff', fontWeight: 700,
                fontSize: 14, textDecoration: 'none', alignSelf: 'flex-start',
              }}
            >
              Explore Cities
            </Link>
          </div>
        </section>

        {/* ── Email signup ── */}
        <section style={{ padding: '72px 24px', textAlign: 'center', background: '#fafafa' }}>
          <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#111' }}>
            ✦ &nbsp;You've got great taste. So do our emails.&nbsp; ✦
          </p>
          <p style={{ fontSize: 14, color: '#999', marginBottom: 28 }}>
            Follow along as we share new restaurants, collabs, and promos.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            <input
              type="email"
              placeholder="Email Address"
              style={{ padding: '12px 18px', borderRadius: 8, border: '1.5px solid #ddd', fontSize: 14, outline: 'none', width: 280, fontFamily: "'DM Sans', sans-serif", color: '#111', background: '#fff' }}
            />
            <button style={{ padding: '12px 24px', borderRadius: 8, border: 'none', background: GRADIENT, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}>
              Sign Up
            </button>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer style={{ borderTop: '1px solid #f0f0f0', padding: '32px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <Image
            src="https://images.squarespace-cdn.com/content/v1/66b4e6b122f497787aca9a8d/b9850e99-4990-4bca-8105-90d3004d4d1e/disco-cater-horizontal-hires.png?format=200w"
            alt="Disco Cater" width={100} height={28} style={{ objectFit: 'contain' }}
          />
          <p style={{ fontSize: 13, color: '#999', margin: 0 }}>
            Powered by <a href="https://www.familymeal.com" style={{ color: '#6B6EF9', textDecoration: 'none' }}>FamilyMeal</a> · © FamilyMeal Concepts Inc. 2024
          </p>
          <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
            <a href="https://www.instagram.com/eat.disco" style={{ color: '#999', textDecoration: 'none' }}>Instagram</a>
            <a href="mailto:info@familymeal.com" style={{ color: '#999', textDecoration: 'none' }}>Email</a>
          </div>
        </footer>

      </div>
    </>
  )
}