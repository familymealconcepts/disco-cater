'use client'
import { useEffect, useState } from 'react'
import { ModifierMultiPicker, type PickerItem } from './ModifierMultiPicker'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const RED = '#E53935'

export interface DiscoGroupSummary {
  reference: string
  name: string
  external_name: string | null
  min_selected: number
  max_selected: number
  modifierReferences: string[]
}

const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }
const card: React.CSSProperties = { background: '#fff', borderRadius: 14, padding: '26px 28px', width: 460, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', fontFamily: F }
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, fontFamily: F, boxSizing: 'border-box' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', margin: '0 0 6px' }

// Create/edit a Disco-native modifier group inline — used by the menu-item
// dialog's "+ Add New Group" flow so creating a group from within an item
// never requires leaving the item editor, plus the nested "existing or new"
// modifier picker (ModifierMultiPicker) inside it — the same two-layer
// existing-or-new pattern FM's Angular admin had (group, then modifiers).
export function DiscoGroupFormDialog({
  mode, initial, restaurantRef, onClose, onSaved,
}: {
  mode: 'create' | 'edit'
  initial?: DiscoGroupSummary
  restaurantRef: string
  onClose: () => void
  onSaved: (group: DiscoGroupSummary) => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [externalName, setExternalName] = useState(initial?.external_name || '')
  const [minSelected, setMinSelected] = useState(String(initial?.min_selected ?? 0))
  const [maxSelected, setMaxSelected] = useState(String(initial?.max_selected ?? 1))
  const [modifierReferences, setModifierReferences] = useState<string[]>(initial?.modifierReferences || [])
  const [library, setLibrary] = useState<PickerItem[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/restaurant/disco-modifiers').then(r => r.ok ? r.json() : { modifiers: [] })
      .then(d => setLibrary(Array.isArray(d.modifiers) ? d.modifiers.map((m: PickerItem) => ({ reference: m.reference, name: m.name, price: m.price })) : []))
      .catch(() => {})
  }, [])

  async function createModifier(name: string, price: number): Promise<PickerItem | null> {
    try {
      const res = await fetch('/api/restaurant/disco-modifiers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurant_reference: restaurantRef, name, price }),
      })
      if (!res.ok) return null
      const d = await res.json().catch(() => ({}))
      if (!d.reference) return null
      const created = { reference: d.reference as string, name, price }
      setLibrary(prev => [...prev, created])
      return created
    } catch { return null }
  }

  async function save() {
    setErr('')
    const nm = name.trim()
    if (!nm) { setErr('Group name is required.'); return }
    const min = parseInt(minSelected, 10) || 0
    const max = parseInt(maxSelected, 10) || 1
    if (min > max) { setErr('Minimum cannot be greater than maximum.'); return }
    if (max < 1 || max > 50) { setErr('Maximum must be between 1 and 50.'); return }
    setSaving(true)
    try {
      // #13 (menu-manager/groups convention): the customer-facing subtitle is
      // derived from the selection rule, not a separate free-text field.
      const subExternalName = min > 0 ? 'Required' : 'Optional'
      const body = { restaurant_reference: restaurantRef, name: nm, externalName: externalName.trim(), subExternalName, minSelected: min, maxSelected: max, modifierReferences }
      const res = mode === 'edit' && initial?.reference
        ? await fetch(`/api/restaurant/disco-modifier-groups/${initial.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/disco-modifier-groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setErr(d.error || 'Could not save the group.')
        setSaving(false)
        return
      }
      const data = await res.json().catch(() => ({}))
      const reference = initial?.reference || data.reference || ''
      onSaved({ reference, name: nm, external_name: body.externalName, min_selected: min, max_selected: max, modifierReferences })
    } catch {
      setErr('Could not save the group.')
      setSaving(false)
    }
  }

  const draftMin = parseInt(minSelected, 10) || 0

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: '0 0 16px' }}>{mode === 'create' ? 'Add New Group' : 'Edit Group'}</h2>
        {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: RED, marginBottom: 14 }}>{err}</div>}
        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Group name (internal) *</label>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} style={input} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Customer-facing name</label>
          <input value={externalName} onChange={e => setExternalName(e.target.value)} placeholder="e.g. Choose a sauce" style={input} />
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><label style={lbl}>Min selected</label><input value={minSelected} onChange={e => setMinSelected(e.target.value)} inputMode="numeric" style={input} /></div>
          <div style={{ flex: 1 }}><label style={lbl}>Max selected</label><input value={maxSelected} onChange={e => setMaxSelected(e.target.value)} inputMode="numeric" style={input} /></div>
        </div>
        <div style={{ marginBottom: 16, fontSize: 12.5, color: '#777' }}>
          Customers will see this group as{' '}
          <strong style={{ color: draftMin > 0 ? '#B45309' : '#4046B8' }}>{draftMin > 0 ? 'Required' : 'Optional'}</strong>
          {' '}(from Min selected {draftMin > 0 ? '≥ 1' : '= 0'}).
        </div>
        <label style={lbl}>Modifiers in this group{modifierReferences.length > 0 ? ` (${modifierReferences.length} selected)` : ''}</label>
        <ModifierMultiPicker library={library} selected={modifierReferences} onChange={setModifierReferences} onCreateNew={createModifier} />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
