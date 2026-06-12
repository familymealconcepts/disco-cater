'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

// Map a Disco-native session/login payload to the restaurant_user shape the
// portal layout reads (name display + ADMIN-role nav).
function storeDiscoUser(d: { email?: string; firstName?: string | null; lastName?: string | null; restaurantReference?: string; restaurantName?: string | null }) {
  try {
    localStorage.setItem('restaurant_user', JSON.stringify({
      email: d.email || '', firstName: d.firstName || '', lastName: d.lastName || '',
      role: 'ADMIN', reference: d.restaurantReference || '', businessName: d.restaurantName || '',
    }))
  } catch { /* localStorage unavailable */ }
}

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export default function RestaurantLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Already signed in with a Disco-native session? Skip the form.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/disco-restaurant-auth/me', { credentials: 'include' })
        if (!res.ok || cancelled) return
        const s = await res.json()
        storeDiscoUser(s)
        router.replace('/restaurant/dashboard')
      } catch { /* not logged in — show the form */ }
    })()
    return () => { cancelled = true }
  }, [router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      // Try Disco-native auth first; fall back to FM for legacy restaurant users.
      try {
        const dres = await fetch('/api/disco-restaurant-auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify({ email, password }),
        })
        if (dres.ok) {
          storeDiscoUser(await dres.json())
          router.push('/restaurant/dashboard')
          return
        }
      } catch { /* fall through to FM login */ }

      const res = await fetch('/api/restaurant-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Login failed. Please check your credentials.')
        return
      }
      localStorage.setItem('restaurant_user', JSON.stringify(data))

      // Post-login routing by role:
      //   SUPER_ADMIN  → /restaurant/dashboard (Reporting; sees all
      //                  locations via the top-right dropdown, no
      //                  picker required)
      //   SYSTEM_ADMIN → /restaurant/manage/locations (so they can
      //                  click into a location to operate it). With
      //                  exactly one location we auto-pick + land on
      //                  the dashboard.
      //   ADMIN / RESTAURANT_USER → /restaurant/orders (their daily
      //                  surface; JWT already carries the restaurant)
      const role: string = data.role || ''

      if (role === 'SUPER_ADMIN') {
        router.push('/restaurant/dashboard')
        return
      }

      if (role === 'SYSTEM_ADMIN') {
        try {
          const locRes = await fetch('/api/restaurant/locations?size=1000', { credentials: 'include' })
          if (locRes.ok) {
            const locData = await locRes.json()
            const list: { reference: string; businessName: string }[] = locData.content || []
            if (list.length === 1) {
              const only = list[0]
              await fetch(`/api/restaurant/selected-restaurant?restaurantReference=${only.reference}`, {
                method: 'PUT', credentials: 'include',
              })
              try {
                localStorage.setItem('selectedRestaurant', only.reference)
                localStorage.setItem('selectedRestaurantName', only.businessName)
              } catch {}
              router.push('/restaurant/dashboard')
              return
            }
          }
        } catch {
          // If the locations fetch failed, fall through to the
          // Locations management page — the user can pick from there.
        }
        router.push('/restaurant/manage/locations')
        return
      }

      // ADMIN / RESTAURANT_USER / RESTAURANT_ADMIN
      router.push('/restaurant/orders')
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .r-input { width: 100%; padding: 11px 14px; border: 1.5px solid #e0e0e0; border-radius: 9px; font-size: 14px; font-family: ${F}; color: ${DARK}; outline: none; background: #fff; transition: border-color 0.15s; }
        .r-input:focus { border-color: ${INDIGO}; box-shadow: 0 0 0 3px rgba(107,110,249,0.12); }
        .r-btn { width: 100%; padding: 12px; background: ${INDIGO}; color: #fff; border: none; border-radius: 9px; font-size: 14px; font-weight: 700; font-family: ${F}; cursor: pointer; transition: opacity 0.15s; }
        .r-btn:hover:not(:disabled) { opacity: 0.9; }
        .r-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8FC', fontFamily: F, padding: '24px 16px' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <span style={{ fontSize: 22, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: '#999' }}> cater</span>
            <div style={{ fontSize: 12, color: '#aaa', marginTop: 4, fontWeight: 500, letterSpacing: '0.04em' }}>Restaurant Portal</div>
          </div>

          <div style={{ background: '#fff', borderRadius: 16, padding: '32px 28px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, marginBottom: 6, marginTop: 0 }}>
              Log in to Restaurant Portal
            </h1>
            <p style={{ fontSize: 13, color: '#888', marginBottom: 24, marginTop: 0 }}>
              Use your Disco Cater restaurant account credentials.
            </p>

            {error && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 13, color: '#DC2626', fontWeight: 500 }}>
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
                  Email address
                </label>
                <input
                  className="r-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@restaurant.com"
                  required
                  autoComplete="email"
                />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
                  Password
                </label>
                <input
                  className="r-input"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
              </div>
              <button type="submit" className="r-btn" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>

          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <Link href="/" style={{ fontSize: 13, color: '#888', textDecoration: 'none' }}>
              ← Back to Disco Cater
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
