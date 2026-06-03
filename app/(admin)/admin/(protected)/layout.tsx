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
      { title: 'Marketplace', path: '/admin/manage-restaurants/marketplace' },
      { title: 'Import Menus', path: '/admin/manage-restaurants/bulk-import-menu' },
      { title: 'Menu Import', path: '/admin/manage-restaurants/menu-import' },
    ],
  },
  { title: 'Menus', path: '/admin/manage-menus' },
  { title: 'Banking', path: '/admin/manage-banking', comingSoon: true },
  { title: 'Settings', path: '/admin/manage-settings', comingSoon: true },
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_user')
      if (raw) setUser(JSON.parse(raw))
    } catch {}
  }, [])

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
      `}</style>

      <div style={{ display: 'flex', minHeight: '100svh', fontFamily: F }}>
        {/* Sidebar */}
        <aside style={{
          width: SW, background: SIDEBAR_BG, position: 'fixed', top: 0, left: 0,
          height: '100vh', overflow: 'hidden auto', display: 'flex', flexDirection: 'column',
          flexShrink: 0, zIndex: 100,
        }}>
          {/* Logo */}
          <div style={{ padding: '22px 18px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
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
                      onClick={() => setExpanded(isOpen && !groupActive ? null : item.title)}
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
        <div style={{ marginLeft: SW, flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <main style={{ flex: 1, background: '#F7F8FC', minHeight: '100vh' }}>
            {children}
          </main>
        </div>
      </div>
    </>
  )
}
