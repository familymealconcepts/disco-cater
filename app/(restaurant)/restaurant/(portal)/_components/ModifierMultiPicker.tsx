'use client'
import { useState } from 'react'

const F = "'DM Sans', sans-serif"
const BLUE = '#6B6EF9'

export interface PickerItem { reference: string; name: string; price: number }

// Reusable "existing-or-new" modifier picker for a modifier group: an ordered,
// drag-to-reorder list of the group's selected modifiers, a search-to-add list
// of the rest of the library, and an inline create-new-modifier mini-form — the
// layered existing-or-new pattern FM's Angular admin had, without ever leaving
// the group/item dialog. Data-source-agnostic: FM add-ons and Disco-native
// disco_modifiers use different endpoints, so the caller supplies the library
// and persists new modifiers; this component only manages selection/order/UI.
// Drag reorder matches the existing draggedRef/dragOverRef HTML5 DnD idiom
// already used for group reorder in _MealPackageForm.tsx.
//
// orderPersists (default true): FM's own backend re-sorts a group's modifiers
// by each modifier's global library position on every read, discarding any
// custom order — confirmed live. Dragging there would appear to work and then
// silently revert, which is worse than not offering it. The two systems never
// share a call site (FM-backed pages always pass false, Disco-native pages
// never pass it), so this is a static prop per caller, not a runtime check.
export function ModifierMultiPicker({
  library, selected, onChange, onCreateNew, orderPersists = true,
}: {
  library: PickerItem[]
  selected: string[]
  onChange: (next: string[]) => void
  onCreateNew: (name: string, price: number) => Promise<PickerItem | null>
  orderPersists?: boolean
}) {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [createErr, setCreateErr] = useState('')
  const [savingNew, setSavingNew] = useState(false)
  const [draggedRef, setDraggedRef] = useState<string | null>(null)
  const [dragOverRef, setDragOverRef] = useState<string | null>(null)

  const byRef = new Map(library.map(m => [m.reference, m]))
  const selectedItems = selected.map(r => byRef.get(r)).filter((m): m is PickerItem => !!m)
  const availableItems = library.filter(m => !selected.includes(m.reference))
  const q = search.trim().toLowerCase()
  const shownAvailable = q ? availableItems.filter(m => m.name.toLowerCase().includes(q)) : availableItems

  function add(ref: string) { onChange([...selected, ref]) }
  function remove(ref: string) { onChange(selected.filter(r => r !== ref)) }

  function onDragStart(e: React.DragEvent, ref: string) {
    setDraggedRef(ref)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', ref) } catch {}
  }
  function onDragOver(e: React.DragEvent, ref: string) {
    e.preventDefault()
    if (ref !== draggedRef && ref !== dragOverRef) setDragOverRef(ref)
  }
  function onDrop(e: React.DragEvent, toRef: string) {
    e.preventDefault()
    const fromRef = draggedRef
    setDraggedRef(null); setDragOverRef(null)
    if (!fromRef || fromRef === toRef) return
    const from = selected.indexOf(fromRef)
    const to = selected.indexOf(toRef)
    if (from < 0 || to < 0) return
    const next = [...selected]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }
  function onDragEnd() { setDraggedRef(null); setDragOverRef(null) }

  async function submitNew() {
    setCreateErr('')
    const name = newName.trim()
    if (!name) { setCreateErr('Name is required.'); return }
    const price = parseFloat(newPrice) || 0
    setSavingNew(true)
    try {
      const created = await onCreateNew(name, price)
      if (!created) { setCreateErr('Could not create modifier.'); return }
      onChange([...selected, created.reference])
      setNewName(''); setNewPrice(''); setCreating(false)
    } finally { setSavingNew(false) }
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 13, fontFamily: F, boxSizing: 'border-box' }
  const rowBase: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', fontSize: 13, fontFamily: F }

  return (
    <div>
      {!orderPersists && (
        <div style={{ fontSize: 12, color: '#999', padding: '0 0 8px' }}>Modifier order follows your modifier library for this restaurant.</div>
      )}
      {selectedItems.length > 0 ? (
        <div style={{ border: '1px solid #eee', borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
          {selectedItems.map((m, i) => (
            <div
              key={m.reference}
              onDragOver={orderPersists ? e => onDragOver(e, m.reference) : undefined}
              onDrop={orderPersists ? e => onDrop(e, m.reference) : undefined}
              onDragEnd={orderPersists ? onDragEnd : undefined}
              style={{ ...rowBase, borderTop: i > 0 ? '1px solid #f4f4f8' : undefined, background: dragOverRef === m.reference ? '#EEF2FF' : draggedRef === m.reference ? '#f7f7fb' : '#fff' }}
            >
              {orderPersists && (
                <span draggable onDragStart={e => onDragStart(e, m.reference)} title="Drag to reorder" style={{ cursor: 'grab', color: '#bbb', userSelect: 'none' }}>⠿</span>
              )}
              <span style={{ flex: 1 }}>{m.name}</span>
              <span style={{ color: '#999' }}>${Number(m.price).toFixed(2)}</span>
              <button type="button" onClick={() => remove(m.reference)} title="Remove from group" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c00', fontSize: 13 }}>✕</button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: '#999', padding: '4px 0 10px' }}>No modifiers in this group yet.</div>
      )}

      {library.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search existing modifiers…" style={{ ...inputStyle, marginBottom: 6 }} />
          {shownAvailable.length > 0 ? (
            <div style={{ border: '1px solid #eee', borderRadius: 8, maxHeight: 160, overflowY: 'auto' }}>
              {shownAvailable.map((m, i) => (
                <button
                  key={m.reference} type="button" onClick={() => add(m.reference)}
                  style={{ ...rowBase, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', borderTop: i > 0 ? '1px solid #f4f4f8' : undefined }}
                >
                  <span style={{ color: BLUE, fontSize: 14 }}>+</span>
                  <span style={{ flex: 1 }}>{m.name}</span>
                  <span style={{ color: '#999' }}>${Number(m.price).toFixed(2)}</span>
                </button>
              ))}
            </div>
          ) : q && (
            <div style={{ fontSize: 12.5, color: '#999', padding: '4px 0' }}>No modifiers match “{search}”.</div>
          )}
        </div>
      )}

      {creating ? (
        <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, background: '#fafafe' }}>
          {createErr && <div style={{ fontSize: 12, color: '#E53935', marginBottom: 8 }}>{createErr}</div>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New modifier name" style={{ ...inputStyle, flex: 2 }} autoFocus />
            <input value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setCreating(false); setCreateErr(''); setNewName(''); setNewPrice('') }}
              style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '6px 14px', fontSize: 12.5, cursor: 'pointer', fontFamily: F }}>Cancel</button>
            <button type="button" onClick={submitNew} disabled={savingNew}
              style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 7, padding: '6px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F, opacity: savingNew ? 0.6 : 1 }}>
              {savingNew ? 'Adding…' : 'Add Modifier'}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setCreating(true)}
          style={{ background: '#fff', border: `1px solid ${BLUE}`, color: BLUE, borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
          + Create New Modifier
        </button>
      )}
    </div>
  )
}
