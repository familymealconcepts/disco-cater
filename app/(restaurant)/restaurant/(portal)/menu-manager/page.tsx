'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface Menu {
  reference: string; name: string; url: string | null
  visible: boolean; availability_mode: string
}

export default function MenuManagerPage() {
  const router = useRouter()
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/restaurant/disco-menus')
      .then(r => (r.ok ? r.json() : { menus: [] }))
      .then(d => setMenus(Array.isArray(d.menus) ? d.menus : []))
      .catch(() => setMenus([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Menus</h1>
        <button onClick={() => router.push('/restaurant/menu-manager/new')}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          Create Menu
        </button>
      </div>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
      ) : menus.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
          No menus yet. Click <strong>Create Menu</strong> to build your first one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {menus.map(m => (
            <div key={m.reference}
              style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
              onClick={() => router.push(`/restaurant/menu-manager/${m.reference}`)}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: DARK, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {m.name}
                  {!m.visible && <span style={{ fontSize: 10, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 8px' }}>HIDDEN</span>}
                </div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                  {m.availability_mode === 'CUSTOM' ? 'Custom dates' : 'Always available'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <button onClick={e => { e.stopPropagation(); router.push(`/restaurant/menu-manager/${m.reference}/edit`) }}
                  style={{ background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Settings</button>
                <span style={{ color: '#ccc', fontSize: 18 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
