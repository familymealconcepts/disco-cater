'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useAuthContext } from '../context/AuthContext'
import AuthModal from './AuthModal'
import UserMenu from './UserMenu'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export default function GlobalHeader({ centerContent, rightLinks = true }: { centerContent?: React.ReactNode; rightLinks?: boolean }) {
  const { user, isLoading, logout, openAuthModal, authModalOpen, authModalDefaultTab, closeAuthModal } = useAuthContext()
  const [mobileOpen, setMobileOpen] = useState(false)

  async function signOut() {
    await logout()
    // Stay on restaurant pages — the diner is in the middle of browsing/
    // ordering and a logout redirect would be jarring (also kills cart state).
    // Everywhere else, drop to the homepage as before.
    if (!window.location.pathname.startsWith('/restaurants/')) {
      window.location.href = '/'
    }
  }

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
          {rightLinks && <Link href="/for-restaurants" className="dc-link" style={{ color: '#6B6EF9' }}>For Restaurants</Link>}
          {rightLinks && <Link href="/fullmap" className="dc-link">Catering Map</Link>}
          {rightLinks && <Link href="/faq" className="dc-link">FAQ</Link>}

          {!isLoading && (
            user ? (
              <UserMenu />
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
              {!isLoading && (user ? (
                <>
                  {/* Logged-in: greeting first, then account + nav, then sign out. */}
                  <div style={{ padding: '8px 10px 6px', fontSize: 16, fontWeight: 700, color: '#1A1028', fontFamily: F }}>Hi, {user.firstName || 'there'} 👋</div>
                  <div style={{ height: 1, background: '#f0f0f0', margin: '6px 0 8px' }} />
                  <Link href="/account/orders" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>My Account</Link>
                  <Link href="/for-restaurants" className="dc-mobile-item" style={{ color: '#6B6EF9' }} onClick={() => setMobileOpen(false)}>For Restaurants</Link>
                  <Link href="/fullmap" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>Catering Map</Link>
                  <Link href="/faq" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>FAQ</Link>
                  <div style={{ height: 1, background: '#f0f0f0', margin: '8px 0' }} />
                  <button onClick={() => { setMobileOpen(false); signOut() }} style={{ width: '100%', padding: '12px', borderRadius: 999, border: '1.5px solid #f0c0c0', background: '#fff', color: '#E24B4A', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Sign out</button>
                </>
              ) : (
                <>
                  {/* Logged-out menu — unchanged. */}
                  <Link href="/fullmap" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>Catering Map</Link>
                  <Link href="/faq" className="dc-mobile-item" onClick={() => setMobileOpen(false)}>FAQ</Link>
                  <Link href="/for-restaurants" className="dc-mobile-item" style={{ color: '#6B6EF9' }} onClick={() => setMobileOpen(false)}>For Restaurants</Link>
                  <div style={{ height: 1, background: '#f0f0f0', margin: '8px 0' }} />
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
