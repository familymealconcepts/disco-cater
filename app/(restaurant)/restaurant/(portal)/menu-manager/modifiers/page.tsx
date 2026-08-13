'use client'
import { useEffect, useState, useRef } from 'react'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Modifier { reference: string; name: string; price: number; archived: boolean; visible: boolean }
interface GroupLite { reference: string; name: string; modifiers: { reference: string }[] }

// Small hover chip that reveals a list (e.g. the groups a modifier is used in).
function UsedIn({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false)
  if (names.length === 0) return <span style={{ fontSize: 12, color: '#bbb' }}>—</span>
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#555', background: '#F1F1F7', border: '1px solid #e6e6ee', borderRadius: 20, padding: '2px 9px', cursor: 'default', whiteSpace: 'nowrap' }}>
        {names.length} {names.length === 1 ? 'group' : 'groups'}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="#999" aria-hidden><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
      </span>
      {open && (
        <span style={{ position: 'absolute', bottom: '130%', left: 0, zIndex: 20, background: DARK, color: '#fff', borderRadius: 8, padding: '8px 11px', fontSize: 12, lineHeight: 1.5, whiteSpace: 'nowrap', boxShadow: '0 6px 20px rgba(0,0,0,0.22)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span style={{ opacity: 0.6, display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Used in groups</span>
          {names.map((n, i) => <span key={i} style={{ display: 'block' }}>{n}</span>)}
        </span>
      )}
    </span>
  )
}

export default function ModifierLibraryPage() {
  // Live "currently selected" location — used ONLY to detect a switch and
  // trigger a reset/refetch below. Never read at save time (that would
  // reintroduce the stale-intent bug the write-scope fix closes); saves use
  // `restaurantRef`, captured from this page's own load fetch.
  const { ref: selectedRestaurantRef } = useSelectedRestaurant()
  const [modifiers, setModifiers] = useState<Modifier[]>([])
  const [groups, setGroups] = useState<GroupLite[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<null | { reference?: string; name: string; price: string }>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // Captured from the modifiers GET, once per load — the restaurant this
  // page's data was loaded for. Sent explicitly on create so a stale
  // selection can never misfile a new modifier under the wrong restaurant.
  const [restaurantRef, setRestaurantRef] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [mRes, gRes] = await Promise.all([
        fetch(`/api/restaurant/disco-modifiers${showArchived ? '?includeArchived=1' : ''}`).then(r => r.json()),
        fetch('/api/restaurant/disco-modifier-groups').then(r => r.json()).catch(() => ({ groups: [] })),
      ])
      setModifiers(Array.isArray(mRes.modifiers) ? mRes.modifiers : [])
      setGroups(Array.isArray(gRes.groups) ? gRes.groups : [])
      if (mRes.restaurant_reference) setRestaurantRef(mRes.restaurant_reference)
    } catch { setModifiers([]); setGroups([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [showArchived])

  // Reset when the SA switches to a different location so this page never
  // keeps showing stale data for the location it was originally loaded for.
  const mountedSelectionRef = useRef(false)
  useEffect(() => {
    if (!mountedSelectionRef.current) { mountedSelectionRef.current = true; return }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRestaurantRef])

  // modifier reference → names of groups that contain it (#16).
  const groupsByModifier = new Map<string, string[]>()
  for (const g of groups) for (const m of g.modifiers || []) {
    const l = groupsByModifier.get(m.reference) ?? []; l.push(g.name); groupsByModifier.set(m.reference, l)
  }

  async function save() {
    if (!dialog) return
    const name = dialog.name.trim()
    if (!name) { setError('Name is required.'); return }
    if (dialog.price && !/^\d*\.?\d*$/.test(dialog.price)) { setError('Price must be a number.'); return }
    setSaving(true); setError('')
    try {
      const body = { restaurant_reference: restaurantRef, name, price: parseFloat(dialog.price) || 0 }
      const res = dialog.reference
        ? await fetch(`/api/restaurant/disco-modifiers/${dialog.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/disco-modifiers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not save.')
        if (res.status === 400 || res.status === 403 || res.status === 409) load()
        return
      }
      setDialog(null); await load()
    } finally { setSaving(false) }
  }

  async function act(m: Modifier, action: 'archive' | 'unarchive' | 'clone' | 'delete') {
    if (action === 'delete' && !confirm(`Delete "${m.name}"? This can't be undone.`)) return
    if (action === 'archive' || action === 'unarchive') {
      await fetch(`/api/restaurant/disco-modifiers/${m.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: action === 'archive' }) })
    } else if (action === 'clone') {
      await fetch(`/api/restaurant/disco-modifiers/${m.reference}/clone`, { method: 'POST' })
    } else {
      await fetch(`/api/restaurant/disco-modifiers/${m.reference}`, { method: 'DELETE' })
    }
    await load()
  }

  const q = query.trim().toLowerCase()
  const shown = q ? modifiers.filter(m => m.name.toLowerCase().includes(q)) : modifiers

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: BLUE, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: 0 }
  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '9px 14px', borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '9px 14px', fontSize: 13.5, color: DARK, verticalAlign: 'middle', borderBottom: '1px solid #f5f5f8' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Modifiers</h1>
        <button onClick={() => { setError(''); setDialog({ name: '', price: '' }) }}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          Create Modifier
        </button>
      </div>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px' }}>Add-on options (name + price) you can attach to menu items via modifier groups.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search modifiers…"
          style={{ flex: '1 1 260px', maxWidth: 340, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: F, boxSizing: 'border-box' }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
      ) : modifiers.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
          No modifiers yet. Click <strong>Create Modifier</strong> to add your first one.
        </div>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, overflow: 'visible' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Name</th>
              <th style={{ ...th, width: 90 }}>Price</th>
              <th style={{ ...th, width: 120 }}>Used in</th>
              <th style={{ ...th, textAlign: 'right', width: 260 }}>Actions</th>
            </tr></thead>
            <tbody>
              {shown.length === 0 ? (
                <tr><td style={{ ...td, color: '#999', textAlign: 'center' }} colSpan={4}>No modifiers match “{query}”.</td></tr>
              ) : shown.map(m => (
                <tr key={m.reference}>
                  <td style={{ ...td, fontWeight: 600 }}>
                    {m.name}
                    {m.archived && <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 7px' }}>ARCHIVED</span>}
                  </td>
                  <td style={td}>${Number(m.price).toFixed(2)}</td>
                  <td style={td}><UsedIn names={groupsByModifier.get(m.reference) ?? []} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center' }}>
                      {!m.archived && <button style={linkBtn} onClick={() => { setError(''); setDialog({ reference: m.reference, name: m.name, price: String(m.price) }) }}>Edit</button>}
                      <button style={linkBtn} onClick={() => act(m, 'clone')}>Duplicate</button>
                      <button style={linkBtn} onClick={() => act(m, m.archived ? 'unarchive' : 'archive')}>{m.archived ? 'Unarchive' : 'Archive'}</button>
                      <button style={{ ...linkBtn, color: RED }} onClick={() => act(m, 'delete')}>Delete</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setDialog(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '26px 28px', width: 380, maxWidth: '92%', fontFamily: F }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>{dialog.reference ? 'Edit Modifier' : 'Create Modifier'}</h2>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: RED, marginBottom: 14 }}>{error}</div>}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>Name *</label>
            <input autoFocus value={dialog.name} onChange={e => setDialog({ ...dialog, name: e.target.value })}
              style={{ width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: F, marginBottom: 14, boxSizing: 'border-box' }} />
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>Price</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: 10, color: '#999', fontSize: 14 }}>$</span>
              <input value={dialog.price} onChange={e => setDialog({ ...dialog, price: e.target.value })} placeholder="0.00" inputMode="decimal"
                style={{ width: '100%', padding: '10px 12px 10px 24px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: F, boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
              <button onClick={() => setDialog(null)} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
