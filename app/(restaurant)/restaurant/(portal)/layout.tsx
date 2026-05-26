'use client'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

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
}

interface NavItem {
  title: string
  path: string
  badge?: boolean
  children?: { title: string; path: string }[]
}

const ADMIN_NAV: NavItem[] = [
  { title: 'Reporting', path: '/restaurant/dashboard' },
  { title: 'Orders', path: '/restaurant/orders', badge: true },
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

const SYSTEM_ADMIN_NAV: NavItem[] = [
  { title: 'Reporting', path: '/restaurant/dashboard' },
  { title: 'Locations', path: '/restaurant/manage/locations' },
  { title: 'Authorized Users', path: '/restaurant/manage/authorized-users' },
  { title: 'Orders', path: '/restaurant/orders', badge: true },
  { title: 'Links', path: '/restaurant/manage/multi-unit-links' },
  { title: 'Customers', path: '/restaurant/restaurant-customers' },
]

const SYSTEM_ADMIN_IMPERSONATING_NAV: NavItem[] = [
  ...ADMIN_NAV,
]

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<RestaurantUser | null>(null)
  const [restaurantName, setRestaurantName] = useState('')
  const [orderBadge, setOrderBadge] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedRestaurant, setSelectedRestaurant] = useState<string | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('restaurant_user')
      if (raw) setUser(JSON.parse(raw))
      const sel = localStorage.getItem('selectedRestaurant')
      if (sel) setSelectedRestaurant(sel)
    } catch {}
  }, [])

  const isSystemAdmin = user?.role === 'SYSTEM_ADMIN' || user?.role === 'SUPER_ADMIN'
  const isImpersonating = isSystemAdmin && !!selectedRestaurant

  const NAV: NavItem[] = isSystemAdmin
    ? (isImpersonating ? SYSTEM_ADMIN_IMPERSONATING_NAV : SYSTEM_ADMIN_NAV)
    : ADMIN_NAV

  useEffect(() => {
    fetch('/api/restaurant/profile')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.businessName) setRestaurantName(d.businessName) })
      .catch(() => {})
  }, [selectedRestaurant])

  const refreshBadge = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/orders/statistics')
      if (res.ok) {
        const d = await res.json()
        const count = d.unseenByAdmin || 0
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

  async function handleLogout() {
    await fetch('/api/restaurant-auth', { method: 'DELETE' })
    await fetch('/api/restaurant/selected-restaurant', { method: 'DELETE' })
    localStorage.removeItem('restaurant_user')
    localStorage.removeItem('selectedRestaurant')
    router.push('/restaurant/login')
  }

  async function exitImpersonation() {
    await fetch('/api/restaurant/selected-restaurant', { method: 'DELETE' })
    localStorage.removeItem('selectedRestaurant')
    setSelectedRestaurant(null)
    setRestaurantName('')
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
      `}</style>

      <div style={{ display: 'flex', minHeight: '100svh', fontFamily: F }}>
        {/* Sidebar */}
        <aside style={{
          width: SW, background: DARK, position: 'fixed', top: 0, left: 0,
          height: '100vh', overflow: 'hidden auto', display: 'flex', flexDirection: 'column',
          flexShrink: 0, zIndex: 100,
        }}>
          {/* Logo */}
          <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <div style={{ marginBottom: 2 }}>
              <span style={{ fontSize: 18, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
              <span style={{ fontSize: 18, fontWeight: 800, color: '#999' }}> cater</span>
            </div>
            {restaurantName && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 500, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {restaurantName}
              </div>
            )}
          </div>

          {/* SYSTEM_ADMIN location switcher */}
          {isSystemAdmin && (
            <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(107,110,249,0.06)' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                {isImpersonating ? 'Viewing as Restaurant' : 'System Admin'}
              </div>
              {isImpersonating ? (
                <button onClick={exitImpersonation}
                  style={{ width: '100%', background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: 'rgba(255,255,255,0.75)', fontSize: 11, fontFamily: F, padding: '6px 8px', cursor: 'pointer', textAlign: 'left' }}>
                  ← View as System Admin
                </button>
              ) : (
                <Link href="/restaurant/manage/locations"
                  style={{ display: 'block', fontSize: 11, color: 'rgba(255,255,255,0.6)', textDecoration: 'none', padding: '2px 0' }}>
                  Pick a location →
                </Link>
              )}
            </div>
          )}

          {/* Nav */}
          <nav style={{ flex: 1, padding: '12px 0' }}>
            {NAV.map(item => {
              const groupActive = isGroupActive(item)
              const isOpen = expanded === item.title || groupActive

              if (item.children) {
                return (
                  <div key={item.title}>
                    <div
                      className="portal-nav-group"
                      onClick={() => setExpanded(isOpen && !groupActive ? null : item.title)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 16px', color: groupActive ? '#fff' : 'rgba(255,255,255,0.65)',
                        background: groupActive ? ACTIVE_BG : 'transparent',
                        borderRadius: 8, cursor: 'pointer', margin: '1px 8px',
                        fontSize: 13, fontWeight: groupActive ? 600 : 400,
                        transition: 'background 0.15s',
                      }}
                    >
                      <span>{item.title}</span>
                      <span style={{ fontSize: 9, opacity: 0.6 }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                    {isOpen && (
                      <div>
                        {item.children.map(child => sidebarItem(child.title, child.path, false, true))}
                      </div>
                    )}
                  </div>
                )
              }

              return sidebarItem(item.title, item.path, item.badge)
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
