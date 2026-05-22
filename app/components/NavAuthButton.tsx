'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useAuth } from './useAuth'
import LoginModal from './LoginModal'

const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
const DISCO_DARK = '#1A1028'
const DISCO_PURPLE = '#6B6EF9'
const DISCO_PINK = '#F0468A'

interface NavAuthButtonProps {
  /** 'dark' = white background nav (homepage), 'light' = transparent nav (fullmap) */
  variant?: 'dark' | 'light'
}

export default function NavAuthButton({ variant = 'dark' }: NavAuthButtonProps) {
  const { user, logout, initials, loading } = useAuth()
  const [showLogin, setShowLogin] = useState(false)
  const [showMenu, setShowMenu] = useState(false)

  if (loading) return <div style={{ width: 80 }} />

  return (
    <>
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}

      {user ? (
        <div style={{ position: 'relative' }}>
          {/* Avatar button */}
          <button
            onClick={() => setShowMenu(v => !v)}
            style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none',
              background: GRADIENT, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, color: '#fff',
              fontFamily: "'DM Sans', sans-serif",
              boxShadow: '0 2px 10px rgba(107,110,249,0.35)',
              flexShrink: 0,
            }}
            title={`${user.firstName} ${user.lastName}`}
          >
            {initials}
          </button>

          {/* Dropdown menu */}
          {showMenu && (
            <>
              <div onClick={() => setShowMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 199 }} />
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 200,
                background: '#fff', border: '1.5px solid #eee', borderRadius: 16,
                padding: '8px 0', minWidth: 200,
                boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                fontFamily: "'DM Sans', sans-serif",
              }}>
                {/* User info */}
                <div style={{ padding: '10px 16px 12px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: DISCO_DARK }}>{user.firstName} {user.lastName}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 1 }}>{user.email}</div>
                </div>

                {/* Menu items */}
                {[
                  { label: '📦 My Orders', href: '/portal' },
                  { label: '🔁 Subscriptions', href: '/portal' },
                  { label: '❤️ Favorites', href: '/portal' },
                  { label: '👤 Account', href: '/portal' },
                ].map(item => (
                  <Link
                    key={item.label}
                    href={item.href}
                    onClick={() => setShowMenu(false)}
                    style={{
                      display: 'block', padding: '9px 16px',
                      fontSize: 14, color: '#444', textDecoration: 'none',
                      transition: 'background 0.1s',
                    }}
                    onMouseOver={e => (e.currentTarget as HTMLAnchorElement).style.background = '#f8f8ff'}
                    onMouseOut={e => (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'}
                  >
                    {item.label}
                  </Link>
                ))}

                {/* Sign out */}
                <div style={{ borderTop: '1px solid #f5f5f5', marginTop: 4, paddingTop: 4 }}>
                  <button
                    onClick={() => { logout(); setShowMenu(false) }}
                    style={{
                      width: '100%', padding: '9px 16px',
                      fontSize: 14, color: DISCO_PINK, background: 'none',
                      border: 'none', cursor: 'pointer', textAlign: 'left',
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
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
            padding: '7px 16px', borderRadius: 999,
            border: variant === 'dark' ? 'none' : '1.5px solid rgba(255,255,255,0.3)',
            background: variant === 'dark' ? DISCO_DARK : 'rgba(255,255,255,0.15)',
            color: '#fff', fontSize: 13, fontWeight: 700,
            cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
            transition: 'background 0.15s',
            flexShrink: 0,
          }}
          onMouseOver={e => (e.currentTarget as HTMLButtonElement).style.background = DISCO_PURPLE}
          onMouseOut={e => (e.currentTarget as HTMLButtonElement).style.background = variant === 'dark' ? DISCO_DARK : 'rgba(255,255,255,0.15)'}
        >
          Log in
        </button>
      )}
    </>
  )
}
