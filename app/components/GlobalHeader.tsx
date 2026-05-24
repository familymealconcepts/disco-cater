'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const STORAGE_KEY = 'disco_user'
const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

const IconCard = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
const IconBell = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
const IconUser = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
const IconSignOut = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
const IconOrders = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
const IconSubs = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
const IconFavs = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>

interface User { firstName?: string; lastName?: string; email?: string; token?: string }

export default function GlobalHeader({ centerContent, rightLinks = true, onSignOut }: { centerContent?: React.ReactNode; rightLinks?: boolean; onSignOut?: () => void }) {
  const [user, setUser] = useState<User | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  useEffect(() => {
    const sync = () => {
      try { const s = localStorage.getItem(STORAGE_KEY); setUser(s ? JSON.parse(s) : null) } catch {}
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener('focus', sync); window.removeEventListener('storage', sync) }
  }, [])

  async function signOut() {
    localStorage.removeItem(STORAGE_KEY)
    setUser(null); setMenuOpen(false)
    await fetch('/api/fm-auth', { method: 'DELETE' }).catch(() => {})
    window.location.href = '/'
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail || !loginPassword) { setLoginError('Please enter your email and password.'); return }
    setLoginLoading(true); setLoginError('')
    try {
      const res = await fetch('/api/fm-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: loginEmail, password: loginPassword }) })
      const data = await res.json()
      if (!res.ok) { setLoginError(data.error || 'Invalid email or password.'); setLoginLoading(false); return }
      // Store display data only — JWT is in httpOnly cookie set by the server
      const displayData = { email: data.email, firstName: data.firstName, lastName: data.lastName, phoneNumber: data.phoneNumber, reference: data.reference, role: data.role }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(displayData))
      setUser(displayData); setShowLogin(false); setLoginEmail(''); setLoginPassword('')
      window.location.href = '/portal'
    } catch { setLoginError('Something went wrong.') }
    finally { setLoginLoading(false) }
  }

  const initials = user ? `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase() : ''

  return (
    <>
      <style>{`
        .dc-pill { padding: 4px 12px; border-radius: 20px; border: none; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'DM Sans',sans-serif; white-space: nowrap; transition: all 0.12s; background: #efefef; color: #555; text-decoration: none; display: inline-flex; align-items: center; }
        .dc-pill:hover { background: #e0e0e0; }
        .dc-pill.active { background: #1A1028 !important; color: #fff !important; }
        .dc-link { font-size: 13px; font-weight: 500; color: #555; text-decoration: none; font-family: 'DM Sans',sans-serif; }
        .dc-link:hover { color: #111; }
        .dc-menu-link { display: flex; align-items: center; gap: 9px; padding: 8px 14px; font-size: 12px; color: #444; font-weight: 500; text-decoration: none; font-family: 'DM Sans',sans-serif; transition: background 0.1s; }
        .dc-menu-link:hover { background: #f5f5f5; }
        .dc-menu-btn { display: flex; align-items: center; gap: 9px; padding: 8px 14px; cursor: pointer; font-size: 12px; font-weight: 500; border: none; background: transparent; width: 100%; font-family: 'DM Sans',sans-serif; text-align: left; transition: background 0.1s; }
        .dc-menu-btn:hover { background: #f5f5f5; }
        .dc-pill { padding: 4px 12px; border-radius: 20px; border: none; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'DM Sans',sans-serif; white-space: nowrap; transition: all 0.12s; background: #efefef; color: #555; }
      `}</style>

      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff', flexShrink: 0, position: 'sticky', top: 0, zIndex: 200 }}>

        <Link href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}><span style={{ background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span><span style={{ color: '#999' }}> cater</span></span>
        </Link>

        {centerContent && <>
          <div style={{ width: 1, height: 18, background: '#e8e8e8', flexShrink: 0 }} />
          {centerContent}
        </>}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
          {rightLinks && <Link href="/fullmap" className="dc-link">Catering Map</Link>}
          {rightLinks && <Link href="/faq" className="dc-link">FAQ</Link>}

          {user ? (
            <div style={{ position: 'relative' }}>
              <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#fff', background: GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>
                {initials}
              </button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 399 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#fff', border: '1px solid #e8e8e8', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.12)', minWidth: 210, zIndex: 400, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #f0f0f0' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#111', fontFamily: F }}>{user.firstName} {user.lastName}</div>
                      <div style={{ fontSize: 10, color: '#999', marginTop: 1, fontFamily: F }}>{user.email}</div>
                    </div>
                    <div style={{ padding: '5px 0' }}>
                      {[
                        { icon: <IconOrders />, label: 'My Orders', href: '/portal' },
                        { icon: <IconSubs />, label: 'Subscriptions', href: '/portal' },
                        { icon: <IconFavs />, label: 'Favorites', href: '/portal' },
                        { icon: <IconUser />, label: 'Account', href: '/portal' },
                        { icon: <IconCard />, label: 'Payment methods', href: '/portal' },
                        { icon: <IconBell />, label: 'Notifications', href: '/portal' },
                      ].map(item => (
                        <Link key={item.label} href={item.href} className="dc-menu-link" onClick={() => setMenuOpen(false)}>
                          <span style={{ color: '#999', flexShrink: 0 }}>{item.icon}</span>
                          {item.label}
                        </Link>
                      ))}
                    </div>
                    <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
                    <div style={{ padding: '5px 0' }}>
                      <button onClick={onSignOut || signOut} className="dc-menu-btn" style={{ color: '#E24B4A' }}>
                        <span style={{ color: '#E24B4A', flexShrink: 0 }}><IconSignOut /></span>
                        Sign out
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button onClick={() => setShowLogin(true)} style={{ padding: '7px 18px', borderRadius: 999, border: 'none', background: '#1A1028', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
              Log in
            </button>
          )}
        </div>
      </header>

      {showLogin && (
        <>
          <div onClick={() => setShowLogin(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: '#fff', borderRadius: 20, width: '100%', maxWidth: 400, padding: 36, zIndex: 999, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', fontFamily: F }}>
            <button onClick={() => setShowLogin(false)} style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#bbb' }}>✕</button>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>🪩</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1A1028', letterSpacing: '-0.03em' }}>Welcome back</div>
              <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Sign in to your Disco Cater account</div>
            </div>
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#1A1028', display: 'block', marginBottom: 5 }}>Email address</label>
                <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@company.com" autoFocus style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: F, color: '#1A1028', boxSizing: 'border-box' as const }} />
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#1A1028' }}>Password</label>
                  <a href="https://www.familymeal.com/forgot-password" style={{ fontSize: 12, color: '#6B6EF9', textDecoration: 'none' }}>Forgot password?</a>
                </div>
                <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: F, color: '#1A1028', boxSizing: 'border-box' as const }} />
              </div>
              {loginError && <div style={{ fontSize: 12, color: '#F0468A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{loginError}</div>}
              <button type="submit" disabled={loginLoading} style={{ width: '100%', padding: 13, fontSize: 14, fontWeight: 700, color: '#fff', background: loginLoading ? '#ccc' : '#1A1028', border: 'none', borderRadius: 12, cursor: loginLoading ? 'not-allowed' : 'pointer', fontFamily: F }}>
                {loginLoading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <div style={{ marginTop: 16, textAlign: 'center', fontSize: 12, color: '#888' }}>
              Don&apos;t have an account? <a href="https://www.familymeal.com/registration" style={{ color: '#6B6EF9', textDecoration: 'none', fontWeight: 600 }}>Create one</a>
            </div>
          </div>
        </>
      )}
    </>
  )
}
