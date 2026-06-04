'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useAuthContext } from '../context/AuthContext'
import AuthModal from './AuthModal'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

const IconUser = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
const IconSignOut = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>

export default function GlobalHeader({ centerContent, rightLinks = true }: { centerContent?: React.ReactNode; rightLinks?: boolean }) {
  const { user, isLoading, logout, openAuthModal, authModalOpen, authModalDefaultTab, closeAuthModal } = useAuthContext()
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  async function signOut() {
    setMenuOpen(false)
    await logout()
    // Stay on restaurant pages — the diner is in the middle of browsing/
    // ordering and a logout redirect would be jarring (also kills cart state).
    // Everywhere else, drop to the homepage as before.
    if (!window.location.pathname.startsWith('/restaurants/')) {
      window.location.href = '/'
    }
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
        /* Right nav: full layout on desktop, hidden on mobile (replaced by the
           hamburger). Display lives in CSS — not inline — so the media query can
           hide it. */
        .dc-desktop-nav { margin-left: auto; display: flex; align-items: center; gap: 20px; }
        .dc-hamburger { display: none; margin-left: auto; background: none; border: none; cursor: pointer; padding: 4px; line-height: 0; }
        .dc-mobile-item { display: block; padding: 12px 10px; font-size: 15px; font-weight: 500; color: #333; text-decoration: none; font-family: 'DM Sans',sans-serif; border-radius: 8px; }
        .dc-mobile-item:active { background: #f5f5f5; }
        @media (max-width: 768px) {
          .dc-desktop-nav { display: none; }
          .dc-hamburger { display: inline-flex; align-items: center; justify-content: center; }
        }
      `}</style>

      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff', flexShrink: 0, position: 'sticky', top: 0, zIndex: 200 }}>

        <Link href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}>
            <span style={{ background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
            <span style={{ color: '#999' }}> cater</span>
          </span>
        </Link>

        {centerContent && <>
          <div style={{ width: 1, height: 18, background: '#e8e8e8', flexShrink: 0 }} />
          {centerContent}
        </>}

        <div className="dc-desktop-nav">
          {rightLinks && <Link href="/fullmap" className="dc-link">Catering Map</Link>}
          {rightLinks && <Link href="/faq" className="dc-link">FAQ</Link>}

          {!isLoading && (
            user ? (
              <div style={{ position: 'relative' }}>
                <button
                  onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
                  style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#fff', background: GRAD, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}
                >
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
                      {/* The sidebar at /account/* handles Orders, Subscriptions,
                          History, Favorites, Addresses, Payment, Notifications, and
                          Security navigation — duplicating them here was confusing.
                          The dropdown is now just a quick jump into the portal. */}
                      <div style={{ padding: '5px 0' }}>
                        <Link href="/account/orders" className="dc-menu-link" onClick={() => setMenuOpen(false)}>
                          <span style={{ color: '#999', flexShrink: 0 }}><IconUser /></span>
                          My Account
                        </Link>
                      </div>
                      <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
                      <div style={{ padding: '5px 0' }}>
                        <button onClick={signOut} className="dc-menu-btn" style={{ color: '#E24B4A' }}>
                          <span style={{ color: '#E24B4A', flexShrink: 0 }}><IconSignOut /></span>
                          Sign out
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => openAuthModal(undefined, 'login')}
                  style={{ padding: '7px 16px', borderRadius: 999, border: '1.5px solid #1A1028', background: 'transparent', color: '#1A1028', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
                >
                  Log In
                </button>
                <button
                  onClick={() => openAuthModal(undefined, 'signup')}
                  style={{ padding: '7px 18px', borderRadius: 999, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}
                >
                  Sign Up
                </button>
              </div>
            )
          )}
        </div>

        {/* Mobile hamburger — far right, ≤768px only (see .dc-hamburger CSS). */}
        <button className="dc-hamburger" aria-label="Menu" onClick={() => setMobileOpen(o => !o)}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1A1028" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* Mobile dropdown menu — full-width below the header. */}
        {mobileOpen && (
          <>
            <div onClick={() => setMobileOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', borderBottom: '1px solid #f0f0f0', boxShadow: '0 8px 24px rgba(0,0,0,0.10)', zIndex: 201, padding: '8px 16px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Link href="/fullmap" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>Catering Map</Link>
              <Link href="/faq" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>FAQ</Link>
              <Link href="/become-a-partner" className="dc-mobile-item" style={{ color: '#6B6EF9' }} onClick={() => setMobileOpen(false)}>For Restaurants</Link>
              <div style={{ height: 1, background: '#f0f0f0', margin: '8px 0' }} />
              {!isLoading && (user ? (
                <>
                  <Link href="/account/orders" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>My Account</Link>
                  <button onClick={() => { setMobileOpen(false); signOut() }} style={{ width: '100%', padding: '12px', borderRadius: 999, border: '1.5px solid #f0c0c0', background: '#fff', color: '#E24B4A', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F, marginTop: 4 }}>Sign out</button>
                </>
              ) : (
                <>
                  <button onClick={() => { setMobileOpen(false); openAuthModal(undefined, 'login') }} style={{ width: '100%', padding: '12px', borderRadius: 999, border: '1.5px solid #1A1028', background: 'transparent', color: '#1A1028', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F, marginTop: 4 }}>Log In</button>
                  <button onClick={() => { setMobileOpen(false); openAuthModal(undefined, 'signup') }} style={{ width: '100%', padding: '12px', borderRadius: 999, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F, marginTop: 6 }}>Sign Up</button>
                </>
              ))}
            </div>
          </>
        )}
      </header>

      <AuthModal
        isOpen={authModalOpen}
        onClose={closeAuthModal}
        defaultTab={authModalDefaultTab}
      />
    </>
  )
}
