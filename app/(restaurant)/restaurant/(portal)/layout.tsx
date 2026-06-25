'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useCallback, Fragment } from 'react'
import Link from 'next/link'
import { SelectedRestaurantProvider, useSelectedRestaurant } from './_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const ACTIVE_BG = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const SW = 220

interface RestaurantUser {
  email: string
  firstName: string
  lastName: string
  role: string
  reference: string
  businessName?: string
  groupName?: string
}

interface NavItem {
  title: string
  path: string
  badge?: boolean
  children?: { title: string; path: string }[]
}

// MODE A — full SYSTEM_ADMIN nav (no location-scoped items).
// Mirrors FM SIDEBAR_PATHS_LIST.SYSTEM_ADMIN (paths.constant.ts:15-80).
const SYSTEM_ADMIN_NAV: NavItem[] = [
  { title: 'Reporting', path: '/restaurant/dashboard' },
  { title: 'Locations', path: '/restaurant/manage/locations' },
  { title: 'Authorized Users', path: '/restaurant/manage/authorized-users' },
  { title: 'Orders', path: '/restaurant/orders', badge: true },
  // Team management (locations + sub system admins) now lives inside the
  // Authorized Users page; the standalone /restaurant/team route is kept but
  // hidden from the nav.
  { title: 'Links', path: '/restaurant/manage/multi-unit-links' },
  { title: 'Bulk Menu Editor', path: '/restaurant/manage/bulk-pricing' },
  { title: 'Customers', path: '/restaurant/restaurant-customers' },
]

// MODE B — Restaurant User nav, shown to ADMIN role and to
// SYSTEM_ADMINs viewing a single location ("View as Restaurant User").
const RESTAURANT_USER_NAV: NavItem[] = [
  { title: 'Orders', path: '/restaurant/orders', badge: true },
  // Reports = the Reporting dashboard (charts + scheduled reports). Restaurant
  // users land in the portal post-onboarding and need a way to reach it.
  { title: 'Reports', path: '/restaurant/dashboard' },
  {
    title: 'Manage Menus', path: '/restaurant/manage-v2/menus',
    children: [
      { title: 'Menus', path: '/restaurant/manage-v2/menus' },
      { title: 'Group Library', path: '/restaurant/manage/groups' },
      { title: 'Modifier Library', path: '/restaurant/manage/modifiers' },
    ],
  },
  { title: 'Settings', path: '/restaurant/order-settings' },
  {
    title: 'Account', path: '/restaurant/account/profile',
    children: [
      { title: 'Profile', path: '/restaurant/account/profile' },
      { title: 'Banking', path: '/restaurant/account/banking' },
    ],
  },
  { title: 'Tax Rate', path: '/restaurant/tax-rate' },
  { title: 'Customers', path: '/restaurant/restaurant-customers' },
]

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SelectedRestaurantProvider>
      <PortalLayoutInner>{children}</PortalLayoutInner>
    </SelectedRestaurantProvider>
  )
}

function PortalLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<RestaurantUser | null>(null)
  const [orderBadge, setOrderBadge] = useState(0)
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const { ref: selectedRestaurant, name: selectedRestaurantName, viewMode, setViewMode, clearRestaurant } = useSelectedRestaurant()

  useEffect(() => {
    let cached: string | null = null
    try { cached = localStorage.getItem('restaurant_user') } catch {}
    if (cached) {
      try { setUser(JSON.parse(cached)) } catch {}
    }
    // Always reconcile against the Disco session: it carries the live Neon role,
    // so a SYSTEM_ADMIN promotion (or a brand-new Disco partner with no cache)
    // takes effect on the next load without needing a re-login. FM-authenticated
    // users have no Disco session → /me 401s → we keep the cached FM identity.
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/disco-restaurant-auth/me', { credentials: 'include' })
        if (!res.ok || cancelled) return
        const s = await res.json()
        const u: RestaurantUser = {
          email: s.email || '', firstName: s.firstName || '', lastName: s.lastName || '',
          role: s.role || 'ADMIN', reference: s.restaurantReference || '',
          businessName: s.restaurantName || '', groupName: s.businessName || undefined,
        }
        if (cancelled) return
        setUser(u)
        try { localStorage.setItem('restaurant_user', JSON.stringify(u)) } catch {}
      } catch { /* not a Disco session — keep the cached FM identity */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Proactive refresh-on-load: silently rotates the token when it's expired or
  // within 24h of expiry so restaurant users stay logged in for the full 30-day
  // window. If the refresh token is gone/invalid, the route clears cookies and
  // 401s → bounce to login.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/restaurant-auth/refresh', { method: 'POST' })
        if (res.status === 401) {
          try { localStorage.removeItem('restaurant_user') } catch {}
          router.push('/restaurant/login')
        }
      } catch {}
    })()
  }, [router])

  const isSystemAdmin = user?.role === 'SYSTEM_ADMIN' || user?.role === 'SUPER_ADMIN'
  // ADMIN role is always in Mode B by definition. SYSTEM_ADMIN is in
  // Mode B only when they explicitly pick a location AND viewMode is
  // RESTAURANT_USER (e.g. they clicked a row on Locations).
  const inRestaurantUserView = isSystemAdmin
    ? (viewMode === 'RESTAURANT_USER' && !!selectedRestaurant)
    : true

  // Mode A header shows the account/group name; Mode B shows the
  // specific location. Per spec, the name appears exactly once — under
  // the logo. No secondary callouts anywhere.
  const headerName = inRestaurantUserView
    ? (selectedRestaurantName || '')
    : (user?.groupName || user?.businessName || `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim())

  const NAV: NavItem[] = inRestaurantUserView ? RESTAURANT_USER_NAV : SYSTEM_ADMIN_NAV

  const refreshBadge = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/orders/statistics')
      if (res.ok) {
        const d = await res.json()
        const count = d.newOrdersCount ?? d.unseenByAdmin ?? 0
        setOrderBadge(count)
        localStorage.setItem('newOrdersCount', String(count))
      }
    } catch {}
  }, [])

  useEffect(() => {
    refreshBadge()
    const id = setInterval(refreshBadge, 60000)
    return () => clearInterval(id)
  }, [refreshBadge])

  // Stripe Connect status for the Account nav badge — only relevant in the
  // restaurant-user view (the only mode with an Account item).
  useEffect(() => {
    if (!inRestaurantUserView) { setStripeConnected(null); return }
    let cancelled = false
    fetch('/api/restaurant/stripe-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setStripeConnected(!!d?.connected) })
      .catch(() => { if (!cancelled) setStripeConnected(null) })
    return () => { cancelled = true }
  }, [inRestaurantUserView, selectedRestaurant])

  async function handleLogout() {
    // One endpoint clears BOTH auth paths: it deletes the Disco Neon session +
    // disco_restaurant_token cookie AND the legacy fm_restaurant_token cookies.
    // (The old call only hit /api/restaurant-auth DELETE, which left a
    // disco_restaurant_token in place — so Disco-native users stayed logged in
    // and were bounced straight back to the dashboard.)
    try {
      await fetch('/api/disco-restaurant-auth/logout', { method: 'POST', credentials: 'include' })
    } catch { /* still clear local state + redirect below */ }
    await clearRestaurant()
    try { localStorage.removeItem('restaurant_user') } catch {}
    // Hard navigation so middleware + the login page re-read the now-cleared
    // cookies (a client transition can keep stale auth in memory).
    window.location.href = '/restaurant/login'
  }

  // "← View as System Admin" — clears the picked restaurant (cookie +
  // localStorage), flips viewMode back to SYSTEM_ADMIN, and lands on
  // the Locations page. Per spec, the cookie is fully cleared so all
  // downstream proxy calls return to the All-locations scope.
  async function backToSystemAdmin() {
    await clearRestaurant()
    setViewMode('SYSTEM_ADMIN')
    router.push('/restaurant/manage/locations')
  }

  function isActive(path: string) {
    return pathname === path || (pathname.startsWith(path + '/') && path !== '/restaurant')
  }

  function isGroupActive(item: NavItem) {
    if (isActive(item.path)) return true
    if (item.children) return item.children.some(c => isActive(c.path))
    return false
  }

  const sidebarItem = (title: string, path: string, badge?: boolean, indent?: boolean) => {
    const active = isActive(path)
    return (
      <Link key={path} href={path} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: indent ? '8px 16px 8px 28px' : '10px 16px',
        color: active ? '#fff' : 'rgba(255,255,255,0.65)',
        background: active ? ACTIVE_BG : 'transparent',
        borderRadius: 8, textDecoration: 'none',
        fontSize: indent ? 12 : 13,
        fontWeight: active ? 600 : 400,
        margin: indent ? '1px 8px' : '1px 8px',
        transition: 'background 0.15s',
      }}>
        <span>{title}</span>
        {badge && orderBadge > 0 && (
          <span style={{
            background: '#E76F51', color: '#fff', borderRadius: 10,
            padding: '1px 6px', fontSize: 10, fontWeight: 700, lineHeight: 1.4,
          }}>
            {orderBadge > 99 ? '99+' : orderBadge}
          </span>
        )}
      </Link>
    )
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; font-family: ${F}; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
        .portal-nav-group:hover { background: rgba(107,110,249,0.12) !important; }
        .portal-nav-child:hover { background: rgba(107,110,249,0.15) !important; }
        .portal-back-link:hover { background: rgba(107,110,249,0.18) !important; }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100svh', fontFamily: F }}>
        {/* Sidebar */}
        <aside style={{
          width: SW, background: DARK, position: 'fixed', top: 0, left: 0,
          height: '100vh', overflow: 'hidden auto', display: 'flex', flexDirection: 'column',
          flexShrink: 0, zIndex: 100,
        }}>
          {/* Logo + single context name */}
          <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 18, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: '#999' }}> cater</span>
            </div>
            {headerName && (
              <div title={headerName}
                style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontWeight: 600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {headerName}
              </div>
            )}
          </div>

          {/* View-as-SystemAdmin back link — only when an SA is in Mode B */}
          {isSystemAdmin && inRestaurantUserView && (
            <button
              onClick={backToSystemAdmin}
              className="portal-back-link"
              style={{
                background: 'rgba(107,110,249,0.08)', border: 'none',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                color: '#fff', fontSize: 12, fontFamily: F, fontWeight: 600,
                padding: '12px 16px', cursor: 'pointer', textAlign: 'left',
                width: '100%', transition: 'background 0.15s',
              }}
            >
              <span style={{ marginRight: 8 }}>←</span>
              View as System Admin
            </button>
          )}

          {/* Nav */}
          <nav style={{ flex: 1, padding: '12px 0' }}>
            {NAV.map(item => {
              const groupActive = isGroupActive(item)
              const isOpen = expanded === item.title || groupActive

              if (item.children) {
                return (
                  <Fragment key={item.title}>
                    <div
                      className="portal-nav-group"
                      onClick={() => {
                        setExpanded(item.title)
                        if (!groupActive) router.push(item.path)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 16px', color: groupActive ? '#fff' : 'rgba(255,255,255,0.65)',
                        background: groupActive ? ACTIVE_BG : 'transparent',
                        borderRadius: 8, cursor: 'pointer', margin: '1px 8px',
                        fontSize: 13, fontWeight: groupActive ? 600 : 400,
                        transition: 'background 0.15s',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        {item.title}
                        {item.title === 'Account' && stripeConnected === false && (
                          <span
                            title="Connect your bank account to receive payments"
                            style={{ width: 8, height: 8, borderRadius: '50%', background: '#F59E0B', display: 'inline-block', flexShrink: 0 }}
                          />
                        )}
                      </span>
                      <span style={{ fontSize: 9, opacity: 0.6 }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                    {isOpen && (
                      <div>
                        {item.children.map(child => sidebarItem(child.title, child.path, false, true))}
                      </div>
                    )}
                  </Fragment>
                )
              }

              return <Fragment key={item.path}>{sidebarItem(item.title, item.path, item.badge)}</Fragment>
            })}
          </nav>

          {/* User / Logout */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {user && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.firstName} {user.lastName}
              </div>
            )}
            <button
              onClick={handleLogout}
              style={{
                background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7,
                color: 'rgba(255,255,255,0.6)', fontSize: 12, fontFamily: F,
                padding: '7px 12px', cursor: 'pointer', width: '100%', textAlign: 'left',
                transition: 'border-color 0.15s',
              }}
            >
              Log out
            </button>
          </div>
        </aside>

        {/* Main */}
        <div style={{ marginLeft: SW, flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <main style={{ flex: 1, background: '#F7F8FC', minHeight: '100vh' }}>
            {children}
          </main>
        </div>
      </div>
    </>
  )
}
