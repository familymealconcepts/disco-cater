'use client'
import React, { useState } from 'react'
import { useAuthContext } from '../context/AuthContext'

// Shared logged-in user dropdown (initials avatar + menu). Single source of
// truth so every customer-facing header (GlobalHeader, fullmap, restaurant
// pages, …) renders the SAME menu. Reads auth from useAuthContext; renders
// nothing when logged out (call sites supply their own Log In / Sign Up CTA).

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

const IconOrders = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
const IconSubs = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
const IconFavs = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
const IconUser = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
const IconCard = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
const IconBell = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
const IconSignOut = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>

const MENU: { icon: React.ReactNode; label: string; href: string }[] = [
  { icon: <IconOrders />, label: 'My Orders', href: '/account/orders' },
  { icon: <IconSubs />, label: 'Subscriptions', href: '/account/subscriptions' },
  { icon: <IconFavs />, label: 'Favorites', href: '/account/favorites' },
  { icon: <IconUser />, label: 'Account', href: '/account/profile' },
  { icon: <IconCard />, label: 'Payment methods', href: '/account/payment' },
  { icon: <IconBell />, label: 'Notifications', href: '/account/notifications' },
]

export default function UserMenu() {
  const { user, logout } = useAuthContext()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!user) return null

  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()

  async function signOut() {
    setMenuOpen(false)
    await logout()
    // Stay put while browsing a restaurant (mid-order); otherwise drop home.
    if (!window.location.pathname.startsWith('/restaurants/')) {
      window.location.href = '/'
    }
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
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
              {MENU.map(item => (
                <a key={item.label} href={item.href} onClick={() => setMenuOpen(false)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', fontSize: 12, color: '#444', fontWeight: 500, textDecoration: 'none', fontFamily: F, transition: 'background 0.1s' }}
                  onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                  onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  <span style={{ color: '#999', flexShrink: 0 }}>{item.icon}</span>
                  {item.label}
                </a>
              ))}
            </div>
            <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
            <div style={{ padding: '5px 0' }}>
              <button onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#E24B4A', fontWeight: 500, border: 'none', background: 'transparent', width: '100%', fontFamily: F, textAlign: 'left' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
              >
                <span style={{ color: '#E24B4A', flexShrink: 0 }}><IconSignOut /></span>
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
