'use client'
import { useState } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

// A modifier group from the restaurant's group library.
export interface LibraryGroup {
  reference: string
  name: string
  externalName?: string
  subExternalName?: string
  minSelectedItems: number
  maxSelectedItems: number
  itemCount: number
  // Preserved verbatim so editing a group's name/min/max doesn't wipe its
  // items (FM's group PUT replaces the whole group).
  addOnsReferences: string[]
}

// A group attached to the current meal package (library group + per-item toggle).
export interface AttachedGroup extends LibraryGroup {
  enabled: boolean
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.45)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: F,
}
const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460,
  maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', fontSize: 13, fontFamily: F,
  border: '1px solid #ddd', borderRadius: 8, color: DARK, background: '#fff', outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }
const primaryBtn = (disabled?: boolean): React.CSSProperties => ({
  background: disabled ? '#bbb' : BLUE, color: '#fff', border: 'none', borderRadius: 8,
  padding: '10px 22px', fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: F,
})
const cancelBtn: React.CSSProperties = {
  background: 'transparent', border: '1px solid #ddd', borderRadius: 8,
  padding: '10px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F, color: '#666',
}

function DialogShell({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode
}) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{title}</div>
          <button onClick={onClose} aria-label="Close" style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: '50%', fontSize: 17, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>{children}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 20px', borderTop: '1px solid #f0f0f0' }}>{footer}</div>
      </div>
    </div>
  )
}

// ── Add Existing Group ─────────────────────────────────────────────────────────
export function AddExistingGroupDialog({ candidates, onAdd, onClose }: {
  candidates: LibraryGroup[]
  onAdd: (groups: LibraryGroup[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const q = search.trim().toLowerCase()
  const filtered = q
    ? candidates.filter(g => g.name.toLowerCase().includes(q) || (g.externalName || '').toLowerCase().includes(q))
    : candidates
  const chosen = candidates.filter(g => selected[g.reference])

  return (
    <DialogShell
      title="Add Existing Group"
      onClose={onClose}
      footer={<>
        <button style={cancelBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn(chosen.length === 0)} disabled={chosen.length === 0} onClick={() => onAdd(chosen)}>Save Changes</button>
      </>}
    >
      {candidates.length === 0 ? (
        <div style={{ fontSize: 13, color: '#888', padding: '12px 0' }}>All of your groups are already added to this item.</div>
      ) : (
        <>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search groups…" style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map(g => {
              const on = !!selected[g.reference]
              return (
                <label key={g.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${on ? BLUE : '#eee'}`, borderRadius: 8, cursor: 'pointer', background: on ? '#EEF2FF' : '#fff' }}>
                  <input type="checkbox" checked={on} onChange={e => setSelected(p => ({ ...p, [g.reference]: e.target.checked }))} style={{ accentColor: BLUE, width: 15, height: 15 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>{[g.externalName, `${g.itemCount} item${g.itemCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
                  </div>
                </label>
              )
            })}
            {filtered.length === 0 && <div style={{ fontSize: 13, color: '#aaa', padding: '8px 0' }}>No groups match “{search}”.</div>}
          </div>
        </>
      )}
    </DialogShell>
  )
}

// ── Add New / Edit Group ────────────────────────────────────────────────────────
export function GroupFormDialog({ mode, initial, onSaved, onClose }: {
  mode: 'create' | 'edit'
  initial?: AttachedGroup
  onSaved: (group: AttachedGroup) => void
  onClose: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [externalName, setExternalName] = useState(initial?.externalName || '')
  const [min, setMin] = useState(String(initial?.minSelectedItems ?? 0))
  const [max, setMax] = useState(String(initial?.maxSelectedItems ?? 1))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setErr('')
    const mn = Number(min)
    const mx = Number(max)
    if (!name.trim()) { setErr('Group name is required.'); return }
    if (isNaN(mn) || mn < 0) { setErr('Min must be 0 or more.'); return }
    if (isNaN(mx) || mx < 1) { setErr('Max must be at least 1.'); return }
    if (mn >= mx) { setErr('Min must be less than max.'); return }
    if (mx > 50) { setErr('Max can be at most 50.'); return }

    const body = {
      name: name.trim(),
      externalName: externalName.trim(),
      subExternalName: initial?.subExternalName || '',
      minSelectedItems: mn,
      maxSelectedItems: mx,
      addOnsReferences: initial?.addOnsReferences || [],
    }
    setSaving(true)
    try {
      const res = mode === 'edit' && initial?.reference
        ? await fetch(`/api/restaurant/groups/${initial.reference}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/restaurant/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { setErr('Could not save the group. Please try again.'); setSaving(false); return }
      const data = await res.json().catch(() => ({}))
      const reference = initial?.reference || data.reference || data.id || ''
      onSaved({
        reference,
        name: body.name,
        externalName: body.externalName,
        subExternalName: body.subExternalName,
        minSelectedItems: mn,
        maxSelectedItems: mx,
        itemCount: initial?.itemCount ?? 0,
        addOnsReferences: body.addOnsReferences,
        enabled: initial?.enabled ?? true,
      })
    } catch {
      setErr('Could not save the group. Please try again.')
      setSaving(false)
    }
  }

  return (
    <DialogShell
      title={mode === 'create' ? 'Add New Group' : 'Edit Group'}
      onClose={onClose}
      footer={<>
        <button style={cancelBtn} onClick={onClose}>Cancel</button>
        <button style={primaryBtn(saving)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </>}
    >
      {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: '#E53935', marginBottom: 14 }}>{err}</div>}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Group Name <span style={{ color: '#aaa', fontWeight: 400 }}>(internal)</span></label>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={100} style={inputStyle} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>External Name <span style={{ color: '#aaa', fontWeight: 400 }}>(visible to diner)</span></label>
        <input value={externalName} onChange={e => setExternalName(e.target.value)} maxLength={100} style={inputStyle} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <label style={labelStyle}>Min Selected</label>
          <input type="number" min={0} value={min} onChange={e => setMin(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Max Selected</label>
          <input type="number" min={1} max={50} value={max} onChange={e => setMax(e.target.value)} style={inputStyle} />
        </div>
      </div>
    </DialogShell>
  )
}
