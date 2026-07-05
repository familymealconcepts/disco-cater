'use client'
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Modifier { reference: string; name: string; price: number }
interface Group {
  reference: string; name: string; external_name: string | null; sub_external_name: string | null
  min_selected: number; max_selected: number; archived: boolean; modifiers: Modifier[]
}
interface Draft { reference?: string; name: string; externalName: string; subExternalName: string; minSelected: string; maxSelected: string; modifierReferences: string[] }

export default function GroupLibraryPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [library, setLibrary] = useState<Modifier[]>([])
  const [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState<null | Draft>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [gRes, mRes] = await Promise.all([
        fetch('/api/restaurant/disco-modifier-groups').then(r => r.json()),
        fetch('/api/restaurant/disco-modifiers').then(r => r.json()),
      ])
      setGroups(Array.isArray(gRes.groups) ? gRes.groups : [])
      setLibrary(Array.isArray(mRes.modifiers) ? mRes.modifiers : [])
    } catch { setGroups([]); setLibrary([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function openNew() { setError(''); setDialog({ name: '', externalName: '', subExternalName: '', minSelected: '0', maxSelected: '1', modifierReferences: [] }) }
  function openEdit(g: Group) {
    setError('')
    setDialog({ reference: g.reference, name: g.name, externalName: g.external_name || '', subExternalName: g.sub_external_name || '', minSelected: String(g.min_selected), maxSelected: String(g.max_selected), modifierReferences: g.modifiers.map(m => m.reference) })
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
      const body = { name: dialog.name.trim(), externalName: dialog.externalName.trim(), subExternalName: dialog.subExternalName.trim(), minSelected: min, maxSelected: max, modifierReferences: dialog.modifierReferences }
      const res = dialog.reference
        ? await fetch(`/api/restaurant/disco-modifier-groups/${dialog.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/disco-modifier-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Could not save.'); return }
      setDialog(null); await load()
    } finally { setSaving(false) }
  }

  async function act(g: Group, action: 'clone' | 'delete') {
    if (action === 'delete' && !confirm(`Delete "${g.name}"? It will be removed from any items it's attached to.`)) return
    if (action === 'clone') await fetch(`/api/restaurant/disco-modifier-groups/${g.reference}/clone`, { method: 'POST' })
    else await fetch(`/api/restaurant/disco-modifier-groups/${g.reference}`, { method: 'DELETE' })
    await load()
  }

  function toggleMod(ref: string) {
    if (!dialog) return
    setDialog({ ...dialog, modifierReferences: dialog.modifierReferences.includes(ref) ? dialog.modifierReferences.filter(r => r !== ref) : [...dialog.modifierReferences, ref] })
  }

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: F, boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', margin: '0 0 6px' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Modifier Groups</h1>
        <button onClick={openNew} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Create Group</button>
      </div>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 18px' }}>Groups bundle modifiers with selection rules (e.g. “choose up to 2”), then attach to menu items. Required when the minimum is 1 or more.</p>

      {loading ? <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
        : groups.length === 0 ? (
          <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
            No groups yet. Click <strong>Create Group</strong> to bundle modifiers.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {groups.map(g => (
              <div key={g.reference} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{g.name}</div>
                  <div style={{ fontSize: 12.5, color: '#888', marginTop: 2 }}>
                    {g.external_name ? `“${g.external_name}” · ` : ''}{g.modifiers.length} option{g.modifiers.length === 1 ? '' : 's'} · {g.min_selected > 0 ? `required, ` : ''}min {g.min_selected} / max {g.max_selected}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
                  <button style={linkBtn} onClick={() => openEdit(g)}>Edit</button>
                  <button style={linkBtn} onClick={() => act(g, 'clone')}>Duplicate</button>
                  <button style={{ ...linkBtn, color: RED }} onClick={() => act(g, 'delete')}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

      {dialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setDialog(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '26px 28px', width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', fontFamily: F }} onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>{dialog.reference ? 'Edit Group' : 'Create Group'}</h2>
            {error && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: RED, marginBottom: 14 }}>{error}</div>}
            <div style={{ marginBottom: 14 }}><label style={lbl}>Group name (internal) *</label><input autoFocus value={dialog.name} onChange={e => setDialog({ ...dialog, name: e.target.value })} style={input} /></div>
            <div style={{ marginBottom: 14 }}><label style={lbl}>Customer-facing name</label><input value={dialog.externalName} onChange={e => setDialog({ ...dialog, externalName: e.target.value })} placeholder="e.g. Choose your sides" style={input} /></div>
            <div style={{ marginBottom: 14 }}><label style={lbl}>Customer-facing subtitle</label><input value={dialog.subExternalName} onChange={e => setDialog({ ...dialog, subExternalName: e.target.value })} placeholder="e.g. Select up to 2" style={input} /></div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}><label style={lbl}>Min selected</label><input value={dialog.minSelected} onChange={e => setDialog({ ...dialog, minSelected: e.target.value })} inputMode="numeric" style={input} /></div>
              <div style={{ flex: 1 }}><label style={lbl}>Max selected</label><input value={dialog.maxSelected} onChange={e => setDialog({ ...dialog, maxSelected: e.target.value })} inputMode="numeric" style={input} /></div>
            </div>
            <label style={lbl}>Options in this group</label>
            {library.length === 0 ? (
              <div style={{ fontSize: 13, color: '#999', padding: '8px 0' }}>No modifiers yet — create some in the Modifiers tab first.</div>
            ) : (
              <div style={{ border: '1px solid #eee', borderRadius: 10, maxHeight: 200, overflowY: 'auto' }}>
                {library.map(m => (
                  <label key={m.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: '1px solid #f4f4f8', cursor: 'pointer', fontSize: 14 }}>
                    <input type="checkbox" checked={dialog.modifierReferences.includes(m.reference)} onChange={() => toggleMod(m.reference)} />
                    <span style={{ flex: 1 }}>{m.name}</span>
                    <span style={{ color: '#999' }}>${Number(m.price).toFixed(2)}</span>
                  </label>
                ))}
              </div>
            )}
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
