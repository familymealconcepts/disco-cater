'use client'
import { useEffect, useState, useRef } from 'react'
import { useSelectedRestaurant } from '../../_components/SelectedRestaurantContext'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Modifier { reference: string; name: string; price: number }
interface Group {
  reference: string; name: string; external_name: string | null; sub_external_name: string | null
  min_selected: number; max_selected: number; archived: boolean; modifiers: Modifier[]; itemsUsedIn?: string[]
}
interface Draft { reference?: string; name: string; externalName: string; minSelected: string; maxSelected: string; modifierReferences: string[] }

// Small hover chip that reveals a list (e.g. the menu items a group is used in).
function UsedIn({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false)
  if (names.length === 0) return <span style={{ fontSize: 12, color: '#bbb' }}>—</span>
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#555', background: '#F1F1F7', border: '1px solid #e6e6ee', borderRadius: 20, padding: '2px 9px', cursor: 'default', whiteSpace: 'nowrap' }}>
        {names.length} {names.length === 1 ? 'item' : 'items'}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="#999" aria-hidden><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
      </span>
      {open && (
        <span style={{ position: 'absolute', bottom: '130%', left: 0, zIndex: 20, background: DARK, color: '#fff', borderRadius: 8, padding: '8px 11px', fontSize: 12, lineHeight: 1.5, whiteSpace: 'nowrap', boxShadow: '0 6px 20px rgba(0,0,0,0.22)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <span style={{ opacity: 0.6, display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Used in menu items</span>
          {names.map((n, i) => <span key={i} style={{ display: 'block' }}>{n}</span>)}
        </span>
      )}
    </span>
  )
}

export default function GroupLibraryPage() {
  // Live "currently selected" location — used ONLY to detect a switch and
  // trigger a reset/refetch below. Never read at save time (that would
  // reintroduce the stale-intent bug the write-scope fix closes); saves use
  // `restaurantRef`, captured from this page's own load fetch.
  const { ref: selectedRestaurantRef } = useSelectedRestaurant()
  const [groups, setGroups] = useState<Group[]>([])
  const [library, setLibrary] = useState<Modifier[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [dialog, setDialog] = useState<null | Draft>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [modSearch, setModSearch] = useState('')
  // Captured from the groups GET, once per load — the restaurant this page's
  // data was loaded for. Sent explicitly on create so a stale selection can
  // never misfile a new group under the wrong restaurant.
  const [restaurantRef, setRestaurantRef] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [gRes, mRes] = await Promise.all([
        fetch(`/api/restaurant/disco-modifier-groups${showArchived ? '?includeArchived=1' : ''}`).then(r => r.json()),
        fetch('/api/restaurant/disco-modifiers').then(r => r.json()),
      ])
      setGroups(Array.isArray(gRes.groups) ? gRes.groups : [])
      setLibrary(Array.isArray(mRes.modifiers) ? mRes.modifiers : [])
      if (gRes.restaurant_reference) setRestaurantRef(gRes.restaurant_reference)
    } catch { setGroups([]); setLibrary([]) } finally { setLoading(false) }
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

  function openNew() { setError(''); setModSearch(''); setDialog({ name: '', externalName: '', minSelected: '0', maxSelected: '1', modifierReferences: [] }) }
  function openEdit(g: Group) {
    setError(''); setModSearch('')
    setDialog({ reference: g.reference, name: g.name, externalName: g.external_name || '', minSelected: String(g.min_selected), maxSelected: String(g.max_selected), modifierReferences: g.modifiers.map(m => m.reference) })
  }

  async function save() {
    if (!dialog) return
    if (!dialog.name.trim()) { setError('Group name is required.'); return }
    const min = parseInt(dialog.minSelected, 10) || 0
    const max = parseInt(dialog.maxSelected, 10) || 1
    if (min > max) { setError('Minimum cannot be greater than maximum.'); return }
    if (max < 1 || max > 50) { setError('Maximum must be between 1 and 50.'); return }
    setSaving(true); setError('')
    try {
      // #13: the customer-facing subtitle is derived from the selection rule
      // (Required when at least one selection is mandatory, else Optional) rather
      // than a separate free-text field.
      const subExternalName = min > 0 ? 'Required' : 'Optional'
      const body = { restaurant_reference: restaurantRef, name: dialog.name.trim(), externalName: dialog.externalName.trim(), subExternalName, minSelected: min, maxSelected: max, modifierReferences: dialog.modifierReferences }
      const res = dialog.reference
        ? await fetch(`/api/restaurant/disco-modifier-groups/${dialog.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/disco-modifier-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not save.')
        if (res.status === 400 || res.status === 403 || res.status === 409) load()
        return
      }
      setDialog(null); await load()
    } finally { setSaving(false) }
  }

  async function act(g: Group, action: 'clone' | 'delete' | 'archive' | 'unarchive') {
    if (action === 'delete' && !confirm(`Delete "${g.name}"? It will be removed from any items it's attached to.`)) return
    if (action === 'clone') await fetch(`/api/restaurant/disco-modifier-groups/${g.reference}/clone`, { method: 'POST' })
    else if (action === 'archive' || action === 'unarchive') await fetch(`/api/restaurant/disco-modifier-groups/${g.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: action === 'archive' }) })
    else await fetch(`/api/restaurant/disco-modifier-groups/${g.reference}`, { method: 'DELETE' })
    await load()
  }

  function toggleMod(ref: string) {
    if (!dialog) return
    setDialog({ ...dialog, modifierReferences: dialog.modifierReferences.includes(ref) ? dialog.modifierReferences.filter(r => r !== ref) : [...dialog.modifierReferences, ref] })
  }

  const q = query.trim().toLowerCase()
  const shown = q ? groups.filter(g => g.name.toLowerCase().includes(q) || (g.external_name || '').toLowerCase().includes(q)) : groups

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: BLUE, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: 0 }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: F, boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', margin: '0 0 6px' }
  const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '9px 14px', borderBottom: '1px solid #eee', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '9px 14px', fontSize: 13.5, color: DARK, verticalAlign: 'middle', borderBottom: '1px solid #f5f5f8' }

  const draftMin = dialog ? (parseInt(dialog.minSelected, 10) || 0) : 0

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Modifier Groups</h1>
        <button onClick={openNew} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Create Group</button>
      </div>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 16px' }}>Groups bundle modifiers with selection rules (e.g. “choose up to 2”), then attach to menu items. Required when the minimum is 1 or more.</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search groups…"
          style={{ flex: '1 1 260px', maxWidth: 340, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontFamily: F, boxSizing: 'border-box' }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', cursor: 'pointer' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {loading ? <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
        : groups.length === 0 ? (
          <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
            No groups yet. Click <strong>Create Group</strong> to bundle modifiers.
          </div>
        ) : (
          <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, overflow: 'visible' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Name</th>
                <th style={th}>Customer-facing</th>
                <th style={{ ...th, width: 80 }}>Options</th>
                <th style={{ ...th, width: 120 }}>Rule</th>
                <th style={{ ...th, width: 100 }}>Used in</th>
                <th style={{ ...th, textAlign: 'right', width: 200 }}>Actions</th>
              </tr></thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td style={{ ...td, color: '#999', textAlign: 'center' }} colSpan={6}>No groups match “{query}”.</td></tr>
                ) : shown.map(g => (
                  <tr key={g.reference}>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {g.name}
                      {g.archived && <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 7px' }}>ARCHIVED</span>}
                    </td>
                    <td style={{ ...td, color: '#666' }}>{g.external_name || '—'}</td>
                    <td style={td}>{g.modifiers.length}</td>
                    <td style={td}>
                      <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 20, padding: '2px 8px', background: g.min_selected > 0 ? '#FEF3E2' : '#EEF0FD', color: g.min_selected > 0 ? '#B45309' : '#4046B8' }}>
                        {g.min_selected > 0 ? 'Required' : 'Optional'}
                      </span>
                      <span style={{ fontSize: 11, color: '#aaa', marginLeft: 6 }}>{g.min_selected}/{g.max_selected}</span>
                    </td>
                    <td style={td}><UsedIn names={g.itemsUsedIn ?? []} /></td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center' }}>
                        {!g.archived && <button style={linkBtn} onClick={() => openEdit(g)}>Edit</button>}
                        <button style={linkBtn} onClick={() => act(g, 'clone')}>Duplicate</button>
                        <button style={linkBtn} onClick={() => act(g, g.archived ? 'unarchive' : 'archive')}>{g.archived ? 'Unarchive' : 'Archive'}</button>
                        <button style={{ ...linkBtn, color: RED }} onClick={() => act(g, 'delete')}>Delete</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {dialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setDialog(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '26px 28px', width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', fontFamily: F }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>{dialog.reference ? 'Edit Group' : 'Create Group'}</h2>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: RED, marginBottom: 14 }}>{error}</div>}
            <div style={{ marginBottom: 14 }}><label style={lbl}>Group name (internal) *</label><input autoFocus value={dialog.name} onChange={e => setDialog({ ...dialog, name: e.target.value })} style={input} /></div>
            <div style={{ marginBottom: 14 }}><label style={lbl}>Customer-facing name</label><input value={dialog.externalName} onChange={e => setDialog({ ...dialog, externalName: e.target.value })} placeholder="e.g. Choose size." style={input} /></div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Min selected</label><input value={dialog.minSelected} onChange={e => setDialog({ ...dialog, minSelected: e.target.value })} inputMode="numeric" style={input} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Max selected</label><input value={dialog.maxSelected} onChange={e => setDialog({ ...dialog, maxSelected: e.target.value })} inputMode="numeric" style={input} /></div>
            </div>
            {/* #13: customer-facing subtitle is auto-derived from the min selection. */}
            <div style={{ marginBottom: 16, fontSize: 12.5, color: '#777' }}>
              Customers will see this group as{' '}
              <strong style={{ color: draftMin > 0 ? '#B45309' : '#4046B8' }}>{draftMin > 0 ? 'Required' : 'Optional'}</strong>
              {' '}(from Min selected {draftMin > 0 ? '≥ 1' : '= 0'}).
            </div>
            <label style={lbl}>Options in this group{dialog.modifierReferences.length > 0 ? ` (${dialog.modifierReferences.length} selected)` : ''}</label>
            {library.length === 0 ? (
              <div style={{ fontSize: 13, color: '#999', padding: '8px 0' }}>No modifiers yet — create some in the Modifiers tab first.</div>
            ) : (() => {
              const mq = modSearch.trim().toLowerCase()
              const list = mq ? library.filter(m => m.name.toLowerCase().includes(mq)) : library
              return (
                <>
                  <input value={modSearch} onChange={e => setModSearch(e.target.value)} placeholder="Search modifiers…" style={{ ...input, marginBottom: 8 }} />
                  <div style={{ border: '1px solid #eee', borderRadius: 10, maxHeight: 300, overflowY: 'auto' }}>
                    {list.length === 0 ? (
                      <div style={{ fontSize: 13, color: '#999', padding: '12px' }}>No modifiers match “{modSearch}”.</div>
                    ) : list.map(m => (
                      <label key={m.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: '1px solid #f4f4f8', cursor: 'pointer', fontSize: 14 }}>
                        <input type="checkbox" checked={dialog.modifierReferences.includes(m.reference)} onChange={() => toggleMod(m.reference)} />
                        <span style={{ flex: 1 }}>{m.name}</span>
                        <span style={{ color: '#999' }}>${Number(m.price).toFixed(2)}</span>
                      </label>
                    ))}
                  </div>
                </>
              )
            })()}
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
