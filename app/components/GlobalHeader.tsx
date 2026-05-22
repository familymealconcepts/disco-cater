'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
const DISCO_DARK = '#1A1028'
const DISCO_PURPLE = '#6B6EF9'
const DISCO_PINK = '#F0468A'

interface User {
  email: string
  firstName: string
  lastName: string
}

const STORAGE_KEY = 'disco_user'

export default function GlobalHeader() {
  const pathname = usePathname()
  const [user, setUser] = useState<User | null>(null)
  const [showLogin, setShowLogin] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Hide header on fullmap — it has its own complex header
  const isFullmap = pathname === '/fullmap'
  if (isFullmap) return null

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) setUser(JSON.parse(stored))
    } catch {}

    // Listen for login/logout from any page
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        try {
          setUser(e.newValue ? JSON.parse(e.newValue) : null)
        } catch {}
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const initials = user
    ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
    : ''

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail || !loginPassword) { setLoginError('Please enter your email and password.'); return }
    setLoginLoading(true)
    setLoginError('')
    try {
      const res = await fetch('/api/fm-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) { setLoginError(data.error || 'Invalid email or password.'); setLoginLoading(false); return }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      setUser(data)
      setShowLogin(false)
      setLoginEmail('')
      setLoginPassword('')
    } catch {
      setLoginError('Something went wrong. Please try again.')
    } finally {
      setLoginLoading(false)
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY)
    setUser(null)
    setShowMenu(false)
    window.location.href = '/'
  }

  const navLinks = [
    { href: '/fullmap', label: 'Catering Map' },
    { href: '/faq', label: 'FAQ' },
  ]

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap');
        .disco-header-link { color: #555; text-decoration: none; font-size: 14px; font-weight: 500; transition: color 0.15s; font-family: 'DM Sans', sans-serif; }
        .disco-header-link:hover { color: #6B6EF9; }
        .disco-header-link.active { color: #6B6EF9; font-weight: 600; }
        .disco-menu-item { display: block; padding: 9px 16px; font-size: 14px; color: #444; text-decoration: none; transition: background 0.1s; font-family: 'DM Sans', sans-serif; background: transparent; border: none; cursor: pointer; width: 100%; text-align: left; }
        .disco-menu-item:hover { background: #f8f8ff; }
        @keyframes discoFadeUp { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      `}</style>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 500,
        background: '#fff',
        borderBottom: '1.5px solid #f0f0f0',
        display: 'flex', alignItems: 'center',
        padding: '0 32px', height: 56,
        fontFamily: "'DM Sans', sans-serif",
        boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
      }}>
        {/* Logo */}
        <Link href="/" style={{ flexShrink: 0, marginRight: 32, display: 'flex', alignItems: 'center' }}>
          <img
            src="/disco-cater-logo.png"
            alt="Disco Cater"
            style={{ height: 30, objectFit: 'contain', display: 'block' }}
          />
        </Link>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Nav links */}
        <nav style={{ display: 'flex', alignItems: 'center', gap: 28, marginRight: 24 }}>
          {navLinks.map(link => (
            <Link
              key={link.href}
              href={link.href}
              className={`disco-header-link${pathname === link.href ? ' active' : ''}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Auth */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {user ? (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowMenu(v => !v)}
                style={{
                  width: 34, height: 34, borderRadius: '50%',
                  border: 'none', background: GRADIENT,
                  cursor: 'pointer', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, fontWeight: 800,
                  color: '#fff', fontFamily: "'DM Sans', sans-serif",
                  boxShadow: '0 2px 10px rgba(107,110,249,0.35)',
                }}
                title={`${user.firstName} ${user.lastName}`}
              >
                {initials}
              </button>

              {showMenu && (
                <>
                  <div onClick={() => setShowMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 498 }} />
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 10px)', right: 0,
                    zIndex: 499, background: '#fff',
                    border: '1.5px solid #eee', borderRadius: 16,
                    padding: '8px 0', minWidth: 210,
                    boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                    animation: 'discoFadeUp 0.18s ease',
                  }}>
                    <div style={{ padding: '10px 16px 12px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: DISCO_DARK }}>{user.firstName} {user.lastName}</div>
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{user.email}</div>
                    </div>
                    {[
                      { label: '📦  My Orders', href: '/portal?tab=orders' },
                      { label: '🔁  Subscriptions', href: '/portal?tab=subscriptions' },
                      { label: '❤️  Favorites', href: '/portal?tab=favorites' },
                      { label: '👤  Account', href: '/portal?tab=account' },
                    ].map(item => (
                      <Link key={item.label} href={item.href} className="disco-menu-item" onClick={() => setShowMenu(false)}>
                        {item.label}
                      </Link>
                    ))}
                    <div style={{ borderTop: '1px solid #f5f5f5', marginTop: 4, paddingTop: 4 }}>
                      <button className="disco-menu-item" onClick={logout} style={{ color: DISCO_PINK }}>
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              onClick={() => setShowLogin(true)}
              style={{
                padding: '7px 18px', borderRadius: 999,
                border: 'none', background: DISCO_DARK,
                color: '#fff', fontSize: 13, fontWeight: 700,
                cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                transition: 'background 0.15s',
              }}
              onMouseOver={e => (e.currentTarget as HTMLButtonElement).style.background = DISCO_PURPLE}
              onMouseOut={e => (e.currentTarget as HTMLButtonElement).style.background = DISCO_DARK}
            >
              Log in
            </button>
          )}
        </div>
      </header>

      {/* ── Login Modal ── */}
      {showLogin && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(26,16,40,0.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
          onClick={() => setShowLogin(false)}
        >
          <div
            style={{ background: '#fff', borderRadius: 24, width: '100%', maxWidth: 400, padding: 32, boxShadow: '0 24px 80px rgba(0,0,0,0.2)', animation: 'discoFadeUp 0.2s ease', fontFamily: "'DM Sans', sans-serif" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 800, color: DISCO_DARK, letterSpacing: '-0.03em' }}>Sign in 🪩</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>Use your FamilyMeal account</div>
              </div>
              <button onClick={() => setShowLogin(false)} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 18, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
            </div>

            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK, display: 'block', marginBottom: 6 }}>Email</label>
                <input
                  type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
                  placeholder="you@company.com" autoFocus
                  style={{ width: '100%', padding: '12px 14px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
                  onBlur={e => e.target.style.borderColor = '#e8e8e8'}
                />
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK }}>Password</label>
                  <a href="#" style={{ fontSize: 12, color: DISCO_PURPLE, textDecoration: 'none' }}>Forgot password?</a>
                </div>
                <input
                  type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', padding: '12px 14px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, boxSizing: 'border-box' }}
                  onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
                  onBlur={e => e.target.style.borderColor = '#e8e8e8'}
                />
              </div>
              {loginError && (
                <div style={{ fontSize: 13, color: DISCO_PINK, marginBottom: 16, padding: '10px 14px', background: '#FFF0F3', borderRadius: 10, border: '1px solid #FFD0DC' }}>{loginError}</div>
              )}
              <button
                type="submit" disabled={loginLoading}
                style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 700, color: '#fff', background: loginLoading ? '#ccc' : DISCO_DARK, border: 'none', borderRadius: 12, cursor: loginLoading ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", transition: 'background 0.15s' }}
                onMouseOver={e => { if (!loginLoading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_PURPLE }}
                onMouseOut={e => { if (!loginLoading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_DARK }}
              >
                {loginLoading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
