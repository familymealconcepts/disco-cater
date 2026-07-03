'use client'
import { useEffect, useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

interface Modifier { reference: string; name: string; price: number; archived: boolean; visible: boolean }

export default function ModifierLibraryPage() {
  const [modifiers, setModifiers] = useState<Modifier[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [dialog, setDialog] = useState<null | { reference?: string; name: string; price: string }>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(`/api/restaurant/disco-modifiers${showArchived ? '?includeArchived=1' : ''}`)
      const d = await res.json()
      setModifiers(Array.isArray(d.modifiers) ? d.modifiers : [])
    } catch { setModifiers([]) } finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [showArchived])

  async function save() {
    if (!dialog) return
    const name = dialog.name.trim()
    if (!name) { setError('Name is required.'); return }
    if (dialog.price && !/^\d*\.?\d*$/.test(dialog.price)) { setError('Price must be a number.'); return }
    setSaving(true); setError('')
    try {
      const body = { name, price: parseFloat(dialog.price) || 0 }
      const res = dialog.reference
        ? await fetch(`/api/restaurant/disco-modifiers/${dialog.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/disco-modifiers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Could not save.'); return }
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

  const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Modifiers</h1>
        <button onClick={() => { setError(''); setDialog({ name: '', price: '' }) }}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          Create Modifier
        </button>
      </div>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 18px' }}>Add-on options (name + price) you can attach to menu items via modifier groups.</p>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', marginBottom: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
      </label>

      {loading ? (
        <div style={{ color: '#aaa', fontSize: 14 }}>Loading…</div>
      ) : modifiers.length === 0 ? (
        <div style={{ background: '#fff', border: '1px dashed #ddd', borderRadius: 12, padding: '40px 24px', textAlign: 'center', color: '#888', fontSize: 14 }}>
          No modifiers yet. Click <strong>Create Modifier</strong> to add your first one.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {modifiers.map(m => (
            <div key={m.reference} style={{ background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: DARK, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {m.name}
                  {m.archived && <span style={{ fontSize: 10, fontWeight: 700, background: '#F3F4F6', color: '#6B7280', borderRadius: 20, padding: '2px 8px' }}>ARCHIVED</span>}
                </div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>${Number(m.price).toFixed(2)}</div>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexShrink: 0 }}>
                {!m.archived && <button style={linkBtn} onClick={() => { setError(''); setDialog({ reference: m.reference, name: m.name, price: String(m.price) }) }}>Edit</button>}
                <button style={linkBtn} onClick={() => act(m, 'clone')}>Duplicate</button>
                <button style={linkBtn} onClick={() => act(m, m.archived ? 'unarchive' : 'archive')}>{m.archived ? 'Unarchive' : 'Archive'}</button>
                <button style={{ ...linkBtn, color: RED }} onClick={() => act(m, 'delete')}>Delete</button>
              </div>
            </div>
          ))}
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
