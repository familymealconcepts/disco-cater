'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Menu {
  reference: string; name: string; url: string | null
  visible: boolean; archived: boolean; position: number; availability_mode: string
}

export default function MenuManagerPage() {
  const router = useRouter()
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/restaurant/disco-menus${showArchived ? '?includeArchived=1' : ''}`)
      const d = r.ok ? await r.json() : { menus: [] }
      setMenus(Array.isArray(d.menus) ? d.menus : [])
    } catch { setMenus([]) } finally { setLoading(false) }
  }, [showArchived])
  useEffect(() => { load() }, [load])

  async function act(ref: string, url: string, method: string) {
    setBusy(ref)
    try { await fetch(url, { method }); await load() } finally { setBusy(null) }
  }
  const duplicate = (ref: string) => act(ref, `/api/restaurant/disco-menus/${ref}/clone`, 'POST')
  const unarchive = (ref: string) => act(ref, `/api/restaurant/disco-menus/${ref}/unarchive`, 'POST')
  const archive = (m: Menu) => { if (confirm(`Archive "${m.name}"? It will be hidden from customers, and you can restore it from "Show archived".`)) act(m.reference, `/api/restaurant/disco-menus/${m.reference}`, 'DELETE') }

  async function move(index: number, dir: -1 | 1) {
    const j = index + dir
    if (j < 0 || j >= menus.length || busy) return
    const next = [...menus]
    ;[next[index], next[j]] = [next[j], next[index]]
    setMenus(next) // optimistic
    setBusy('reorder')
    try {
      await fetch('/api/restaurant/disco-menus/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ references: next.map(m => m.reference) }),
      })
    } finally { setBusy(null) }
  }

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: 0, color: BLUE }
  const arrow = (disabled: boolean): React.CSSProperties => ({ width: 22, height: 18, borderRadius: 5, border: '1px solid #e6e6ee', background: '#fff', cursor: disabled ? 'default' : 'pointer', color: disabled ? '#ccc' : '#777', fontSize: 9, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 })

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Menus</h1>
        <button onClick={() => router.push('/restaurant/menu-manager/new')}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          Create Menu
        </button>
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', cursor: 'pointer', marginBottom: 18 }}>
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
      </label>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
      ) : menus.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
          {showArchived ? 'No menus.' : <>No menus yet. Click <strong>Create Menu</strong> to build your first one.</>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {menus.map((m, i) => (
            <div key={m.reference}
              style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', opacity: m.archived ? 0.62 : 1 }}
              onClick={() => router.push(`/restaurant/menu-manager/${m.reference}`)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                {/* Reorder up/down */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} onClick={e => e.stopPropagation()}>
                  <button aria-label="Move up" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} style={arrow(i === 0 || !!busy)}>▲</button>
                  <button aria-label="Move down" disabled={i === menus.length - 1 || !!busy} onClick={() => move(i, 1)} style={arrow(i === menus.length - 1 || !!busy)}>▼</button>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {m.name}
                    {m.archived
                      ? <span style={{ fontSize: 10, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 8px' }}>ARCHIVED</span>
                      : !m.visible && <span style={{ fontSize: 10, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 8px' }}>HIDDEN</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                    {m.availability_mode === 'CUSTOM' ? 'Custom dates' : 'Always available'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                <button disabled={busy === m.reference} style={linkBtn} onClick={() => duplicate(m.reference)}>Duplicate</button>
                {!m.archived && <button style={linkBtn} onClick={() => router.push(`/restaurant/menu-manager/${m.reference}/edit`)}>Settings</button>}
                {m.archived
                  ? <button disabled={busy === m.reference} style={linkBtn} onClick={() => unarchive(m.reference)}>Restore</button>
                  : <button disabled={busy === m.reference} style={{ ...linkBtn, color: RED }} onClick={() => archive(m)}>Archive</button>}
                <span style={{ color: '#ccc', fontSize: 18 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
