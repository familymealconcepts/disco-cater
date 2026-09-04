'use client'
import { useState, useEffect, Fragment } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import GlobalHeader from '../../../components/GlobalHeader'
import { useAuthContext } from '../../../context/AuthContext'
import { isAmexDemoUser, AmexNavIcon } from '../../../../lib/demo/amex-demo' // AMEX DEMO (temporary — see lib/demo/amex-demo.tsx)

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6466E8'
const GRAD = 'linear-gradient(90deg,#6466E8 0%,#C044C8 50%,#F0468A 100%)'

function SvgOrders() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  )
}
function SvgHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  )
}
function SvgFavorites() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  )
}
function SvgProfile() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="7" r="4"/>
      <path d="M4 21v-2a8 8 0 0 1 16 0v2"/>
    </svg>
  )
}
function SvgAddresses() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21s-6-6.5-6-11a6 6 0 0 1 12 0c0 4.5-6 11-6 11z"/>
      <circle cx="12" cy="10" r="2"/>
    </svg>
  )
}
function SvgPayment() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <path d="M2 10h20"/>
    </svg>
  )
}
function SvgSubscriptions() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <polyline points="23 20 23 14 17 14"/>
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"/>
    </svg>
  )
}
function SvgNotifications() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  )
}
function SvgSecurity() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}
function SvgLogout() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  )
}
function SvgChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  )
}
function SvgChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  )
}
function SvgMenu() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  )
}

interface NavEntry { href: string; label: string; icon: React.ReactNode; section?: string }

const NAV: NavEntry[] = [
  // Top section
  { href: '/account/orders', label: 'Orders', icon: <SvgOrders /> },
  { href: '/account/subscriptions', label: 'Subscriptions', icon: <SvgSubscriptions /> },
  { href: '/account/orders/history', label: 'History', icon: <SvgHistory /> },
  { href: '/account/favorites', label: 'Favorites', icon: <SvgFavorites /> },
  // Account section (divider rendered before Profile)
  { href: '/account/profile', label: 'Profile', icon: <SvgProfile />, section: 'Account' },
  { href: '/account/addresses', label: 'Addresses', icon: <SvgAddresses /> },
  { href: '/account/payment', label: 'Payment', icon: <SvgPayment /> },
  // Notifications is a "coming soon" stub — hidden from nav until it's real (C14).
  { href: '/account/security', label: 'Security', icon: <SvgSecurity /> },
]

// AMEX DEMO (temporary) — nav entry injected only for the demo account.
const AMEX_ENTRY: NavEntry = { href: '/account/amex-benefits', label: 'Amex Benefits', icon: <AmexNavIcon /> }

export default function AccountLayoutClient({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuthContext()
  const router = useRouter()
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem('account_sidebar_collapsed')
    if (saved === 'true') setCollapsed(true)
  }, [])

  useEffect(() => {
    if (!isLoading && !user) router.replace('/?login=1')
  }, [user, isLoading, router])

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  function toggleCollapse() {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('account_sidebar_collapsed', String(next))
  }

  async function handleLogout() {
    await logout()
    router.push('/')
  }

  if (isLoading || !user) {
    return (
      <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F, color: '#727272' }}>
        Loading…
      </div>
    )
  }

  const initials = `${user.firstName?.[0] ?? ''}${user.lastName?.[0] ?? ''}`.toUpperCase()
  const sidebarWidth = collapsed ? 56 : 220

  // AMEX DEMO (temporary) — inject the "Amex Benefits" tab after Favorites, for
  // the demo account only. Remove this line + the import to fully strip it.
  const navItems = isAmexDemoUser(user.email) ? [...NAV.slice(0, 4), AMEX_ENTRY, ...NAV.slice(4)] : NAV

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .acct-nav-item {
          display: flex; align-items: center; gap: 11px; padding: 9px 12px;
          border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
          color: #666; font-family: ${F}; text-decoration: none;
          transition: background 0.12s, color 0.12s; white-space: nowrap; overflow: hidden;
        }
        .acct-nav-item:hover { background: #f4f4f8; color: #111; }
        .acct-nav-item.active { background: #EEEDFE; color: ${INDIGO}; font-weight: 700; }
        .acct-nav-item .label { opacity: 1; transition: opacity 0.15s; }
        .acct-sidebar-collapsed .acct-nav-item { justify-content: center; padding: 9px 0; }
        .acct-sidebar-collapsed .acct-nav-item .label { display: none; }
        .acct-toggle-btn {
          display: flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; border-radius: 50%; border: 1px solid #e8e8e8;
          background: #fff; cursor: pointer; color: #727272; transition: background 0.12s, color 0.12s;
        }
        .acct-toggle-btn:hover { background: #f4f4f8; color: #333; }
        .acct-logout-btn {
          display: flex; align-items: center; gap: 10px; width: 100%;
          padding: 9px 12px; border-radius: 8px; border: none; background: transparent;
          cursor: pointer; font-size: 12px; font-weight: 600; color: #727272;
          font-family: ${F}; transition: background 0.12s, color 0.12s;
        }
        .acct-logout-btn:hover { background: #fff0f0; color: #e24b4a; }
        .acct-sidebar-collapsed .acct-logout-btn { justify-content: center; padding: 9px 0; }
        .acct-sidebar-collapsed .acct-logout-btn .label { display: none; }
        .acct-mobile-toggle {
          display: none; align-items: center; gap: 8px;
          padding: 10px 18px; background: #fff; border-bottom: 1px solid #f0f0f0;
          font-family: ${F}; font-size: 13px; font-weight: 600; color: #555;
        }
        .acct-mobile-toggle button { background: none; border: none; cursor: pointer; color: #555; display: flex; align-items: center; }
        @media (max-width: 768px) {
          .acct-desktop-sidebar { display: none !important; }
          .acct-mobile-toggle { display: flex !important; }
          .acct-mobile-drawer {
            position: fixed; top: 0; left: 0; width: 260px; height: 100%;
            background: #fff; z-index: 800; box-shadow: 4px 0 24px rgba(0,0,0,0.12);
            display: flex; flex-direction: column; transform: translateX(-100%);
            transition: transform 0.25s ease;
          }
          .acct-mobile-drawer.open { transform: translateX(0); }
          .acct-mobile-overlay {
            position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 799;
          }
        }
        @media (min-width: 769px) {
          .acct-mobile-drawer { display: none !important; }
          .acct-mobile-overlay { display: none !important; }
        }
      `}</style>

      <div style={{ minHeight: '100svh', display: 'flex', flexDirection: 'column', background: '#fafafa', fontFamily: F }}>
        <GlobalHeader />

        {/* Mobile nav toggle bar */}
        <div className="acct-mobile-toggle">
          <button onClick={() => setMobileOpen(true)} aria-label="Open navigation"><SvgMenu /></button>
          <span style={{ fontSize: 12, color: '#727272', fontWeight: 500 }}>
            {navItems.find(n => pathname.startsWith(n.href))?.label ?? 'Account'}
          </span>
        </div>

        {/* Mobile overlay */}
        {mobileOpen && <div className="acct-mobile-overlay" onClick={() => setMobileOpen(false)} />}

        {/* Mobile drawer */}
        <div className={`acct-mobile-drawer${mobileOpen ? ' open' : ''}`}>
          <SidebarContent
            collapsed={false}
            pathname={pathname}
            user={user}
            initials={initials}
            onLogout={handleLogout}
            onToggle={() => {}}
            showToggle={false}
            navItems={navItems}
          />
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Desktop sidebar */}
          <aside
            className={`acct-desktop-sidebar${collapsed ? ' acct-sidebar-collapsed' : ''}`}
            style={{
              width: sidebarWidth,
              minWidth: sidebarWidth,
              borderRight: '1px solid #f0f0f0',
              background: '#fff',
              display: 'flex',
              flexDirection: 'column',
              transition: 'width 0.2s ease, min-width 0.2s ease',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <SidebarContent
              collapsed={collapsed}
              pathname={pathname}
              user={user}
              initials={initials}
              onLogout={handleLogout}
              onToggle={toggleCollapse}
              showToggle={true}
              navItems={navItems}
            />
          </aside>

          {/* Main content */}
          <main style={{ flex: 1, padding: '32px 36px', minWidth: 0, overflowY: 'auto' }}>
            {children}
          </main>
        </div>
      </div>
    </>
  )
}

function SidebarContent({
  collapsed, pathname, user, initials, onLogout, onToggle, showToggle, navItems,
}: {
  collapsed: boolean
  pathname: string
  user: { firstName: string; lastName: string; email: string }
  initials: string
  onLogout: () => void
  onToggle: () => void
  showToggle: boolean
  navItems: NavEntry[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '16px 10px' }}>
      {/* Toggle button row */}
      {showToggle && (
        <div style={{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end', marginBottom: 12 }}>
          <button className="acct-toggle-btn" onClick={onToggle} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <SvgChevronRight /> : <SvgChevronLeft />}
          </button>
        </div>
      )}

      {/* Nav items */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {navItems.map(item => {
          // FM-style: parent Orders link must NOT be active when on
          // a deeper child path like /account/orders/history — that's the
          // History link's job.
          const isOrdersRoot = item.href === '/account/orders'
          const isActive = isOrdersRoot
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Fragment key={item.href}>
              {item.section && (
                <>
                  {!collapsed ? (
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#727272', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 8px', margin: '12px 0 4px' }}>
                      {item.section}
                    </div>
                  ) : (
                    <div style={{ height: 1, background: '#f0f0f0', margin: '10px 8px' }} />
                  )}
                </>
              )}
              <Link
                href={item.href}
                className={`acct-nav-item${isActive ? ' active' : ''}`}
                title={collapsed ? item.label : undefined}
              >
                <span style={{ flexShrink: 0, display: 'flex' }}>{item.icon}</span>
                <span className="label">{item.label}</span>
              </Link>
            </Fragment>
          )
        })}
      </nav>

      {/* Bottom: user + logout */}
      <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #f0f0f0' }}>
        {/* User info */}
        <div style={{
          display: 'flex', alignItems: 'center',
          gap: collapsed ? 0 : 10,
          padding: collapsed ? '8px 0' : '8px 6px',
          justifyContent: collapsed ? 'center' : 'flex-start',
          marginBottom: 4,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: GRAD,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0,
          }}>
            {initials}
          </div>
          {!collapsed && (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.firstName} {user.lastName}
              </div>
              <div style={{ fontSize: 10, color: '#727272', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.email}
              </div>
            </div>
          )}
        </div>

        {/* Logout */}
        <button
          className="acct-logout-btn"
          onClick={onLogout}
          title={collapsed ? 'Log out' : undefined}
          style={{ justifyContent: collapsed ? 'center' : undefined }}
        >
          <span style={{ flexShrink: 0, display: 'flex' }}><SvgLogout /></span>
          <span className="label">Log out</span>
        </button>
      </div>
    </div>
  )
}
