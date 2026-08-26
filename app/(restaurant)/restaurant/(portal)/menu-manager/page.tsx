'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { MENU_STATE_LABEL, menuState, type MenuState } from '../../../../../lib/menu-state'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Menu {
  reference: string; name: string; url: string | null
  visible: boolean; archived: boolean; position: number; availability_mode: string
  item_count?: number
}

export default function MenuManagerPage() {
  const router = useRouter()
  const [menus, setMenus] = useState<Menu[]>([])
  const [loading, setLoading] = useState(true)
  // Three tabs replacing the old "Show archived" checkbox. The checkbox toggled
  // ONE axis while the other (visible) showed only as a badge on rows mixed in
  // with active ones — so two independent states read as a single vague notion
  // of "not quite on". The tabs are FM's own three, derived from the same two
  // booleans; see lib/menu-state.ts.
  const [tab, setTab] = useState<MenuState>('active')
  const [counts, setCounts] = useState<Record<MenuState, number>>({ active: 0, inactive: 0, archived: 0 })
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/restaurant/disco-menus?tab=${tab}`)
      const d = r.ok ? await r.json() : { menus: [], counts: null }
      setMenus(Array.isArray(d.menus) ? d.menus : [])
      // Counts come from the server for ALL three tabs on every request, so an
      // empty tab shows a real 0 rather than looking like a failed load.
      if (d.counts) setCounts({ active: Number(d.counts.active) || 0, inactive: Number(d.counts.inactive) || 0, archived: Number(d.counts.archived) || 0 })
    } catch { setMenus([]) } finally { setLoading(false) }
  }, [tab])
  useEffect(() => { load() }, [load])

  async function act(ref: string, url: string, method: string) {
    setBusy(ref)
    try { await fetch(url, { method }); await load() } finally { setBusy(null) }
  }
  const duplicate = (ref: string) => act(ref, `/api/restaurant/disco-menus/${ref}/clone`, 'POST')
  const unarchive = (ref: string) => act(ref, `/api/restaurant/disco-menus/${ref}/unarchive`, 'POST')
  const archive = (m: Menu) => { if (confirm(`Archive "${m.name}"? It will be hidden from customers, and you can restore it from the Archived tab.`)) act(m.reference, `/api/restaurant/disco-menus/${m.reference}`, 'DELETE') }

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
  // Same visual weight as the page-level "Create Menu" primary button, sized
  // for an inline row rather than a page header.
  const primaryBtn: React.CSSProperties = { background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: F }
  // Position only governs the order a customer sees, so reordering is offered
  // on Active alone. The Archived tab is sorted by updated_at instead.
  const reorderable = tab === 'active'
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
      {/* Tabs. Reordering is only meaningful where position drives the customer's
          list, so the arrows are hidden outside Active — see `reorderable`. */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #eee', marginBottom: 18 }}>
        {(['active', 'inactive', 'archived'] as MenuState[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ background: 'none', border: 'none', borderBottom: tab === t ? `2px solid ${BLUE}` : '2px solid transparent',
              color: tab === t ? DARK : '#888', fontWeight: tab === t ? 700 : 500, fontSize: 13.5, fontFamily: F,
              padding: '8px 14px', cursor: 'pointer', marginBottom: -1 }}>
            {MENU_STATE_LABEL[t]}
            <span style={{ marginLeft: 7, fontSize: 11.5, fontWeight: 700, color: tab === t ? BLUE : '#aaa' }}>{counts[t]}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
      ) : menus.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
          {tab === 'active'
            ? <>No active menus. Click <strong>Create Menu</strong> to build one, or check the Inactive tab.</>
            : tab === 'inactive'
              ? 'No inactive menus. Menus you hide from customers — seasonal ones, for example — appear here.'
              : 'No archived menus.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {menus.map((m, i) => (
            <div key={m.reference}
              style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', opacity: m.archived ? 0.62 : 1 }}
              onClick={() => router.push(`/restaurant/menu-manager/${m.reference}`)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                {/* Reorder up/down */}
                {reorderable && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} onClick={e => e.stopPropagation()}>
                    <button aria-label="Move up" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} style={arrow(i === 0 || !!busy)}>▲</button>
                    <button aria-label="Move down" disabled={i === menus.length - 1 || !!busy} onClick={() => move(i, 1)} style={arrow(i === menus.length - 1 || !!busy)}>▼</button>
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {m.name}
                    {/* One word per state, from the same map the tabs use, so a
                        restaurant comparing Disco with FM sees "Inactive" in
                        both. This badge said HIDDEN while FM called the same
                        state Inactive. */}
                    {menuState(m) !== 'active' && (
                      <span style={{ fontSize: 10, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 8px' }}>
                        {MENU_STATE_LABEL[menuState(m)]}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                    {m.availability_mode === 'CUSTOM' ? 'Custom dates' : (() => {
                      // Postgres COUNT() comes back as a string (bigint) via the
                      // Neon driver — coerce before the singular/plural check.
                      const n = Number(m.item_count) || 0
                      return `${n} item${n === 1 ? '' : 's'}`
                    })()}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                {!m.archived && <button style={primaryBtn} onClick={() => router.push(`/restaurant/menu-manager/${m.reference}/edit`)}>Menu Settings</button>}
                <button disabled={busy === m.reference} style={linkBtn} onClick={() => duplicate(m.reference)}>Duplicate</button>
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
