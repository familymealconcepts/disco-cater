'use client'
import { useState, useEffect, useCallback } from 'react'
import { ModifierMultiPicker, type PickerItem } from '../../_components/ModifierMultiPicker'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

interface AddOn {
  reference: string
  name: string
  price: number
  achived: boolean
  visible: boolean
}

interface Group {
  reference: string
  name: string
  externalName: string
  subExternalName: string
  minSelectedItems: number
  maxSelectedItems: number
  archived: boolean
  visible: boolean
  addOns: AddOn[]
}

interface GroupForm {
  name: string
  externalName: string
  subExternalName: string
  minSelectedItems: string
  maxSelectedItems: string
  addOnsReferences: string[]
}

const emptyForm = (): GroupForm => ({
  name: '', externalName: '', subExternalName: '',
  minSelectedItems: '0', maxSelectedItems: '1',
  addOnsReferences: [],
})

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', width: 540, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', fontFamily: F }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: DARK }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 }}>{label}</label>
      {children}
      {error && <div style={{ fontSize: 11, color: '#E53935', marginTop: 3 }}>{error}</div>}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8,
  padding: '8px 11px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [addOns, setAddOns] = useState<AddOn[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Group | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<GroupForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<GroupForm>>({})
  const [addOnsError, setAddOnsError] = useState('')
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/restaurant/groups/list')
      if (res.ok) {
        const d = await res.json()
        setGroups(d.content || [])
      }
    } finally { setLoading(false) }
  }, [])

  const loadAddOns = useCallback(async () => {
    try {
      const res = await fetch('/api/restaurant/add-ons?page=0&size=250')
      if (res.ok) {
        const d = await res.json()
        setAddOns(d.content || [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    loadGroups()
    loadAddOns()
  }, [loadGroups, loadAddOns])

  function openCreate() {
    setForm(emptyForm())
    setErrors({})
    setAddOnsError('')
    setCreating(true)
    setEditing(null)
  }

  function openEdit(g: Group) {
    setForm({
      name: g.name,
      externalName: g.externalName || '',
      subExternalName: g.subExternalName || '',
      minSelectedItems: String(g.minSelectedItems),
      maxSelectedItems: String(g.maxSelectedItems),
      addOnsReferences: g.addOns?.map(a => a.reference) || [],
    })
    setErrors({})
    setAddOnsError('')
    setEditing(g)
    setCreating(false)
  }

  function closeModal() {
    setCreating(false)
    setEditing(null)
  }

  function validate(): boolean {
    const e: Partial<GroupForm> = {}
    if (!form.name.trim()) e.name = 'Name is required'
    const mn = Number(form.minSelectedItems)
    const mx = Number(form.maxSelectedItems)
    if (isNaN(mn) || mn < 0) e.minSelectedItems = 'Invalid'
    if (isNaN(mx) || mx < 1) e.maxSelectedItems = 'Must be at least 1'
    if (!isNaN(mn) && !isNaN(mx) && mn >= mx) e.minSelectedItems = 'Min must be less than max'
    if (!isNaN(mx) && mx > 50) e.maxSelectedItems = 'Max value is 50'
    setErrors(e)
    // FM rejects a group with no modifiers outright (confirmed live:
    // "addOnsReferences must not be empty") — checked separately since
    // addOnsReferences isn't a per-field text error like the ones above.
    const addOnsOk = form.addOnsReferences.length > 0
    setAddOnsError(addOnsOk ? '' : 'Add at least one modifier before saving.')
    return Object.keys(e).length === 0 && addOnsOk
  }

  async function handleSave() {
    if (!validate()) return
    setSaving(true)
    const minSelectedItems = Number(form.minSelectedItems)
    const body = {
      name: form.name.trim(),
      externalName: form.externalName.trim(),
      // FM requires 1-255 chars — a blank subtitle 400s. Preserve any custom
      // text the admin typed; only fall back when they left it blank, using
      // the same Required/Optional derivation menu-manager/groups/page.tsx
      // already uses for Disco-native groups.
      subExternalName: form.subExternalName.trim() || (minSelectedItems > 0 ? 'Required' : 'Optional'),
      minSelectedItems,
      maxSelectedItems: Number(form.maxSelectedItems),
      addOnsReferences: form.addOnsReferences,
      // FM's group PUT replaces the whole object — omitting these 500s on
      // edit (confirmed live). A brand-new group has never been archived.
      archived: editing ? editing.archived : false,
      visible: editing ? editing.visible : true,
    }
    try {
      if (editing) {
        await fetch(`/api/restaurant/groups/${editing.reference}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      } else {
        await fetch('/api/restaurant/groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      }
      closeModal()
      loadGroups()
    } finally { setSaving(false) }
  }

  function ask(message: string, onConfirm: () => void) {
    setConfirm({ message, onConfirm })
  }

  async function handleDelete(ref: string, name: string) {
    ask(`Delete group "${name}"? This cannot be undone.`, async () => {
      setConfirm(null)
      await fetch(`/api/restaurant/groups/${ref}`, { method: 'DELETE' })
      loadGroups()
    })
  }

  async function handleClone(ref: string) {
    await fetch(`/api/restaurant/groups/${ref}/clone`, { method: 'POST' })
    loadGroups()
  }

  async function handleArchive(g: Group) {
    // FM's PUT /api/extraItemsGroups/{ref} REPLACES the whole group object, so a
    // partial { archived, visible } body wipes name, external names, min/max and
    // add-ons. Send the COMPLETE object instead — mirrors FM's own groups-table
    // archive(), which PUTs the full element with addOnsReferences =
    // addOns.map(reference). The list load already carries every field FM needs,
    // so we merge the archive flags into it (no extra GET required).
    const body = {
      name: g.name,
      externalName: g.externalName || '',
      subExternalName: g.subExternalName || '',
      minSelectedItems: g.minSelectedItems,
      maxSelectedItems: g.maxSelectedItems,
      addOnsReferences: g.addOns?.map(a => a.reference) || [],
      archived: !g.archived,
      // Archiving forces visible=false (FM does the same); unarchiving merges
      // only `archived` and keeps the group's existing visibility.
      visible: g.archived ? g.visible : false,
    }
    await fetch(`/api/restaurant/groups/${g.reference}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    loadGroups()
  }

  async function createAddOn(name: string, price: number): Promise<PickerItem | null> {
    try {
      const res = await fetch('/api/restaurant/add-ons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, price }) })
      if (!res.ok) return null
      const data = await res.json().catch(() => ({}))
      const reference = data.reference || data.id || ''
      if (!reference) return null
      const created: AddOn = { reference, name, price, achived: false, visible: true }
      setAddOns(prev => [...prev, created])
      return { reference, name, price }
    } catch { return null }
  }

  const thStyle: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888', padding: '10px 12px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
  const tdStyle: React.CSSProperties = { padding: '12px', fontSize: 13, color: DARK, verticalAlign: 'middle' }

  const isOpen = creating || !!editing

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Group Library</h1>
        <button
          onClick={openCreate}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
        >
          + Create Group
        </button>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading...</div>
        ) : groups.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No groups yet. Create your first modifier group.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Customer Name</th>
                <th style={thStyle}>Items</th>
                <th style={thStyle}>Min</th>
                <th style={thStyle}>Max</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g, i) => (
                <tr key={g.reference} style={{ borderTop: i > 0 ? '1px solid #f5f5f5' : undefined }}>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{g.name}</td>
                  <td style={tdStyle}>{g.externalName || '—'}</td>
                  <td style={tdStyle}>{g.addOns?.length ?? 0}</td>
                  <td style={tdStyle}>{g.minSelectedItems}</td>
                  <td style={tdStyle}>{g.maxSelectedItems}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <ActionBtn title="Edit" onClick={() => openEdit(g)}>Edit</ActionBtn>
                      <ActionBtn title="Clone" onClick={() => handleClone(g.reference)}>⧉</ActionBtn>
                      <ActionBtn title={g.archived ? 'Unarchive' : 'Archive'} onClick={() => handleArchive(g)}>
                        {g.archived ? '↩' : '🗄'}
                      </ActionBtn>
                      <ActionBtn title="Delete" red onClick={() => handleDelete(g.reference, g.name)}>✕</ActionBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isOpen && (
        <Modal title={editing ? 'Edit Group' : 'Create Group'} onClose={closeModal}>
          <Field label="Name *" error={errors.name}>
            <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Group name" />
          </Field>
          <Field label="Customer-Facing Name" error={errors.externalName}>
            <input style={inputStyle} value={form.externalName} onChange={e => setForm(f => ({ ...f, externalName: e.target.value }))} placeholder="e.g. Choose a sauce" />
          </Field>
          <Field label="Customer-Facing Subtitle">
            <input style={inputStyle} value={form.subExternalName} onChange={e => setForm(f => ({ ...f, subExternalName: e.target.value }))} placeholder="e.g. Select up to 2" />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Min Selected" error={errors.minSelectedItems}>
              <input style={inputStyle} type="number" min={0} value={form.minSelectedItems} onChange={e => setForm(f => ({ ...f, minSelectedItems: e.target.value }))} />
            </Field>
            <Field label="Max Selected" error={errors.maxSelectedItems}>
              <input style={inputStyle} type="number" min={1} max={50} value={form.maxSelectedItems} onChange={e => setForm(f => ({ ...f, maxSelectedItems: e.target.value }))} />
            </Field>
          </div>

          <Field label={`Add-Ons${form.addOnsReferences.length > 0 ? ` (${form.addOnsReferences.length} selected)` : ''}`} error={addOnsError}>
            <ModifierMultiPicker
              library={addOns.map(a => ({ reference: a.reference, name: a.name, price: a.price }))}
              selected={form.addOnsReferences}
              onChange={refs => setForm(f => ({ ...f, addOnsReferences: refs }))}
              onCreateNew={createAddOn}
              orderPersists={false}
            />
          </Field>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={closeModal} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '9px 20px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 7, padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {confirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '28px 32px', maxWidth: 400, width: '90%', fontFamily: F }}>
            <p style={{ margin: '0 0 24px', color: DARK, fontSize: 15 }}>{confirm.message}</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirm(null)} style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 7, padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
              <button onClick={confirm.onConfirm} style={{ background: '#E53935', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, color: '#fff', cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionBtn({ children, onClick, title, red }: { children: React.ReactNode; onClick: () => void; title?: string; red?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: red ? '#FEF2F2' : '#f5f5f8',
        border: `1px solid ${red ? '#FECACA' : '#e8e8ee'}`,
        borderRadius: 6, padding: '4px 8px', fontSize: 13, cursor: 'pointer',
        color: red ? '#E53935' : '#555', fontFamily: F,
      }}
    >
      {children}
    </button>
  )
}
