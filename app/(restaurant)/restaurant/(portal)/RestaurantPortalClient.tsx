'use client'
import { useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useRestaurant } from './context/RestaurantContext'

const F = "'DM Sans', sans-serif"
const SIDEBAR_BG = '#1A1028'
const ACTIVE_BG = '#6B6EF9'
const HOVER_BG = 'rgba(255,255,255,0.08)'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

// SVG icons
const icons = {
  dashboard: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  orders: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>,
  availability: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  menus: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>,
  packages: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  addons: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>,
  profile: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  delivery: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>,
  payouts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  notifications: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  promos: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  chevronLeft: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
  chevronRight: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  logout: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  menu: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  taxRate: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  customers: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
}

const NAV_PRIMARY = [
  { href: '/restaurant/dashboard', label: 'Reporting', icon: icons.dashboard },
  { href: '/restaurant/orders', label: 'Orders', icon: icons.orders },
]
const NAV_MENU = [
  { href: '/restaurant/menus', label: 'Menus', icon: icons.menus },
  { href: '/restaurant/groups', label: 'Group Library', icon: icons.addons },
  { href: '/restaurant/modifiers', label: 'Modifier Library', icon: icons.packages },
]
const NAV_SETTINGS = [
  { href: '/restaurant/settings/delivery', label: 'Settings', icon: icons.delivery },
  { href: '/restaurant/settings/profile', label: 'Profile', icon: icons.profile },
  { href: '/restaurant/payouts', label: 'Banking', icon: icons.payouts },
  { href: '/restaurant/tax-rate', label: 'Tax Rate', icon: icons.taxRate },
  { href: '/restaurant/customers', label: 'Customers', icon: icons.customers },
]

function NavItem({ href, label, icon, collapsed, active }: { href: string; label: string; icon: React.ReactNode; collapsed: boolean; active: boolean }) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10,
        padding: collapsed ? '9px 0' : '9px 10px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 8, textDecoration: 'none', fontSize: 13, fontWeight: active ? 700 : 500,
        color: active ? '#fff' : 'rgba(255,255,255,0.7)',
        background: active ? ACTIVE_BG : 'transparent',
        transition: 'background 0.12s, color 0.12s',
        marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden',
      }}
      onMouseOver={e => { if (!active) (e.currentTarget as HTMLElement).style.background = HOVER_BG }}
      onMouseOut={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span style={{ flexShrink: 0, display: 'flex', opacity: active ? 1 : 0.8 }}>{icon}</span>
      {!collapsed && <span>{label}</span>}
    </Link>
  )
}

function SectionLabel({ label, collapsed }: { label: string; collapsed: boolean }) {
  if (collapsed) return <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '8px 0' }} />
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '8px 10px 4px' }}>
      {label}
    </div>
  )
}

export default function RestaurantPortalClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { profile } = useRestaurant()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const SIDEBAR_W = collapsed ? 60 : 260

  useEffect(() => {
    const saved = localStorage.getItem('restaurant_sidebar_collapsed')
    if (saved === 'true') setCollapsed(true)
  }, [])

  useEffect(() => { setMobileOpen(false) }, [pathname])

  function toggle() {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('restaurant_sidebar_collapsed', String(next))
  }

  async function handleLogout() {
    await fetch('/api/restaurant-auth', { method: 'DELETE', credentials: 'include' })
    router.push('/restaurant/login')
  }

  const restaurantName = profile?.businessName || profile?.name ||
    (profile?.firstName ? `${profile.firstName} ${profile.lastName || ''}`.trim() : 'Restaurant')

  function Sidebar({ isMobile = false }: { isMobile?: boolean }) {
    const w = isMobile ? 280 : SIDEBAR_W
    const col = isMobile ? false : collapsed
    return (
      <div style={{
        width: w, minWidth: w, background: SIDEBAR_BG,
        display: 'flex', flexDirection: 'column', height: '100%',
        padding: '0 8px', transition: 'width 0.2s ease, min-width 0.2s ease',
        overflow: 'hidden',
      }}>
        {/* Logo + toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: col ? 'center' : 'space-between', padding: '18px 4px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: 12 }}>
          {!col && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 0 }}>
              <span style={{ fontSize: 16, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: 'rgba(255,255,255,0.45)' }}> cater</span>
            </div>
          )}
          {!isMobile && (
            <button
              onClick={toggle}
              style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 6, width: 26, height: 26, cursor: 'pointer', color: 'rgba(255,255,255,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            >
              {col ? icons.chevronRight : icons.chevronLeft}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {NAV_PRIMARY.map(item => (
            <NavItem key={item.href} {...item} collapsed={col} active={pathname === item.href || pathname.startsWith(item.href + '/')} />
          ))}
          <SectionLabel label="Manage Menus" collapsed={col} />
          {NAV_MENU.map(item => (
            <NavItem key={item.href} {...item} collapsed={col} active={pathname === item.href || pathname.startsWith(item.href + '/')} />
          ))}
          <SectionLabel label="Account & Settings" collapsed={col} />
          {NAV_SETTINGS.map(item => (
            <NavItem key={item.href} {...item} collapsed={col} active={pathname === item.href || pathname.startsWith(item.href + '/')} />
          ))}
          <a
            href="https://www.doordash.com/merchant"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: col ? 0 : 10,
              padding: col ? '9px 0' : '9px 10px',
              justifyContent: col ? 'center' : 'flex-start',
              borderRadius: 8, textDecoration: 'none', fontSize: 13, fontWeight: 500,
              color: 'rgba(255,255,255,0.7)', marginBottom: 2,
            }}
            title={col ? 'DoorDash' : undefined}
          >
            <span style={{ flexShrink: 0, display: 'flex', opacity: 0.8 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </span>
            {!col && <span>DoorDash</span>}
          </a>
        </nav>

        {/* Bottom */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12, paddingBottom: 12 }}>
          {!col && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', padding: '0 10px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {restaurantName}
              </div>
              <Link
                href="/"
                style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', padding: '4px 10px 10px', textDecoration: 'none' }}
                onMouseOver={e => (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.8)'}
                onMouseOut={e => (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.5)'}
              >
                ← Switch to Customer View
              </Link>
            </>
          )}
          <button
            onClick={handleLogout}
            title={col ? 'Log out' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: col ? 0 : 9,
              justifyContent: col ? 'center' : 'flex-start',
              width: '100%', padding: col ? '9px 0' : '9px 10px',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 600, fontFamily: F,
              borderRadius: 8, transition: 'background 0.12s, color 0.12s',
            }}
            onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(240,70,138,0.12)'; (e.currentTarget as HTMLElement).style.color = '#F0468A' }}
            onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'none'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.5)' }}
          >
            <span style={{ flexShrink: 0, display: 'flex' }}>{icons.logout}</span>
            {!col && <span>Log Out</span>}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        .r-portal-mobile-bar { display: none; }
        @media (max-width: 768px) {
          .r-portal-desktop-sidebar { display: none !important; }
          .r-portal-mobile-bar { display: flex !important; align-items: center; gap: 10px; padding: 12px 16px; background: ${SIDEBAR_BG}; color: rgba(255,255,255,0.8); font-family: ${F}; font-size: 13px; font-weight: 600; }
          .r-portal-mobile-bar button { background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.8); display: flex; }
          .r-portal-content { padding: 20px 16px !important; }
        }
      `}</style>
      <div style={{ minHeight: '100svh', display: 'flex', fontFamily: F, background: '#F7F8FC' }}>
        {/* Mobile top bar */}
        <div className="r-portal-mobile-bar">
          <button onClick={() => setMobileOpen(true)}>{icons.menu}</button>
          <span>{NAV_PRIMARY.concat(NAV_MENU).concat(NAV_SETTINGS).find(n => pathname.startsWith(n.href))?.label ?? 'Restaurant Portal'}</span>
        </div>

        {/* Mobile drawer overlay */}
        {mobileOpen && (
          <div onClick={() => setMobileOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 800 }} />
        )}
        {/* Mobile drawer */}
        <div style={{ position: 'fixed', top: 0, left: 0, height: '100%', zIndex: 801, transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.25s ease', display: 'flex' }}>
          {mobileOpen && <Sidebar isMobile />}
        </div>

        {/* Desktop sidebar */}
        <div
          className="r-portal-desktop-sidebar"
          style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, transition: 'width 0.2s ease, min-width 0.2s ease', flexShrink: 0 }}
        >
          <div style={{ position: 'sticky', top: 0, height: '100svh' }}>
            <Sidebar />
          </div>
        </div>

        {/* Main content */}
        <main className="r-portal-content" style={{ flex: 1, padding: '28px 32px', minWidth: 0, overflowY: 'auto' }}>
          {children}
        </main>
      </div>
    </>
  )
}
