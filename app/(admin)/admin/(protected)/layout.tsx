'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#0D0D1A'
const GOLD = '#EFB84A'
const SIDEBAR_BG = '#0D0D1A'
const ACTIVE_BG = '#EFB84A'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const SW = 230

interface NavItem {
  title: string
  path: string
  comingSoon?: boolean
  children?: { title: string; path: string }[]
}

const NAV: NavItem[] = [
  { title: 'Dashboard', path: '/admin/dashboard' },
  { title: 'Orders', path: '/admin/manage-orders' },
  { title: 'Users', path: '/admin/manage-users' },
  { title: 'Customers', path: '/admin/manage-customers' },
  { title: 'System Admins', path: '/admin/manage-admins' },
  {
    title: 'Restaurants', path: '/admin/manage-restaurants/ordering',
    children: [
      { title: 'Ordering', path: '/admin/manage-restaurants/ordering' },
      { title: 'Menu Import', path: '/admin/manage-restaurants/menu-import' },
    ],
  },
  { title: 'Menus', path: '/admin/manage-menus' },
  { title: 'Promo Codes', path: '/admin/promo-codes' },
  { title: 'Testing', path: '/admin/testing' },
]

interface AdminUser {
  firstName: string
  lastName: string
  email: string
  role: string
}

export default function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [user, setUser] = useState<AdminUser | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Mobile (<768px) sidebar drawer — opened via the hamburger, auto-closed on
  // navigation.
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => { setSidebarOpen(false) }, [pathname])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_user')
      if (raw) setUser(JSON.parse(raw))
    } catch {}
  }, [])

  // Proactive refresh-on-load: silently rotates the token when it's expired or
  // within 24h of expiry so admins stay logged in for the full 30-day window.
  // If the refresh token is gone/invalid, the route clears cookies and 401s →
  // bounce to login.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin-auth/refresh', { method: 'POST' })
        if (res.status === 401) {
          try { localStorage.removeItem('admin_user') } catch {}
          router.push('/admin/login')
        }
      } catch {}
    })()
  }, [router])

  function isActive(path: string) {
    return pathname === path || pathname.startsWith(path + '/')
  }
  function isGroupActive(item: NavItem) {
    if (isActive(item.path)) return true
    if (item.children) return item.children.some(c => isActive(c.path))
    return false
  }

  async function handleLogout() {
    await fetch('/api/admin-auth', { method: 'DELETE' })
    try { localStorage.removeItem('admin_user') } catch {}
    router.push('/admin/login')
  }

  const sidebarItem = (title: string, path: string, opts?: { indent?: boolean; comingSoon?: boolean }) => {
    const active = isActive(path)
    return (
      <Link key={path} href={path}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: opts?.indent ? '7px 16px 7px 28px' : '9px 16px',
          color: active ? DARK : 'rgba(255,255,255,0.65)',
          background: active ? ACTIVE_BG : 'transparent',
          borderRadius: 8, textDecoration: 'none',
          fontSize: opts?.indent ? 12 : 13,
          fontWeight: active ? 700 : 400,
          margin: '1px 8px',
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        <span>{title}</span>
        {opts?.comingSoon && (
          <span style={{ fontSize: 9, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Soon
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
        .admin-nav-group:hover { background: rgba(239,184,74,0.1) !important; }
        .admin-nav-child:hover { background: rgba(239,184,74,0.12) !important; }

        /* Desktop: fixed sidebar, no mobile chrome. */
        .admin-topbar { display: none; }
        .admin-backdrop { display: none; }
        .admin-close { display: none; }

        /* Mobile: off-canvas sidebar + hamburger top bar. */
        @media (max-width: 767px) {
          .admin-topbar {
            display: flex; align-items: center; justify-content: space-between;
            position: sticky; top: 0; z-index: 90;
            background: ${SIDEBAR_BG}; padding: 12px 16px;
            border-bottom: 1px solid rgba(255,255,255,0.07);
          }
          .admin-sidebar {
            transform: translateX(-100%);
            transition: transform 0.25s ease;
            box-shadow: 4px 0 28px rgba(0,0,0,0.4);
          }
          .admin-sidebar.open { transform: translateX(0); }
          .admin-backdrop.show {
            display: block; position: fixed; inset: 0;
            background: rgba(0,0,0,0.5); z-index: 95;
          }
          .admin-content { margin-left: 0 !important; }
          .admin-close { display: flex; }
        }
      `}</style>

      <div style={{ display: 'flex', minHeight: '100svh', fontFamily: F }}>
        {/* Mobile-only dark backdrop — closes the drawer on tap */}
        <div
          className={`admin-backdrop${sidebarOpen ? ' show' : ''}`}
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />

        {/* Sidebar */}
        <aside className={`admin-sidebar${sidebarOpen ? ' open' : ''}`} style={{
          width: SW, background: SIDEBAR_BG, position: 'fixed', top: 0, left: 0,
          height: '100vh', overflow: 'hidden auto', display: 'flex', flexDirection: 'column',
          flexShrink: 0, zIndex: 100,
        }}>
          {/* Logo */}
          <div style={{ padding: '22px 18px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', position: 'relative' }}>
            <button
              className="admin-close"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
              style={{
                position: 'absolute', top: 16, right: 14,
                width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 8,
                color: 'rgba(255,255,255,0.8)', fontSize: 16, cursor: 'pointer', lineHeight: 1,
              }}
            >
              ✕
            </button>
            <div>
              <span style={{ fontSize: 19, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
              <span style={{ fontSize: 19, fontWeight: 800, color: '#999' }}> cater</span>
            </div>
            <div style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: GOLD, letterSpacing: 1.5 }}>ADMIN</div>
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, padding: '14px 0' }}>
            {NAV.map(item => {
              const groupActive = isGroupActive(item)
              const isOpen = expanded === item.title || groupActive
              if (item.children) {
                return (
                  <div key={item.title}>
                    <div
                      className="admin-nav-group"
                      onClick={() => { router.push(item.path); setExpanded(item.title) }}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '9px 16px',
                        color: groupActive ? DARK : 'rgba(255,255,255,0.65)',
                        background: groupActive ? ACTIVE_BG : 'transparent',
                        borderRadius: 8, cursor: 'pointer', margin: '1px 8px',
                        fontSize: 13, fontWeight: groupActive ? 700 : 400,
                        transition: 'background 0.15s, color 0.15s',
                      }}
                    >
                      <span>{item.title}</span>
                      <span style={{ fontSize: 9, opacity: 0.6 }}>{isOpen ? '▲' : '▼'}</span>
                    </div>
                    {isOpen && (
                      <div>
                        {item.children.map(c => sidebarItem(c.title, c.path, { indent: true }))}
                      </div>
                    )}
                  </div>
                )
              }
              return sidebarItem(item.title, item.path, { comingSoon: item.comingSoon })
            })}
          </nav>

          {/* User / Logout */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {user && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.firstName} {user.lastName}
              </div>
            )}
            <button onClick={handleLogout}
              style={{
                background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 7,
                color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: F,
                padding: '7px 12px', cursor: 'pointer', width: '100%', textAlign: 'left',
              }}
            >
              Log out
            </button>
          </div>
        </aside>

        {/* Main */}
        <div className="admin-content" style={{ marginLeft: SW, flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Mobile top bar — logo + ADMIN tag left, hamburger right */}
          <div className="admin-topbar">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span>
                <span style={{ fontSize: 17, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
                <span style={{ fontSize: 17, fontWeight: 800, color: '#999' }}> cater</span>
              </span>
              <span style={{ fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: 1.5 }}>ADMIN</span>
            </div>
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              style={{
                background: 'transparent', border: 'none', color: '#fff',
                fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: 4,
              }}
            >
              ☰
            </button>
          </div>
          <main style={{ flex: 1, background: '#F7F8FC', minHeight: '100vh' }}>
            {children}
          </main>
        </div>
      </div>
    </>
  )
}
