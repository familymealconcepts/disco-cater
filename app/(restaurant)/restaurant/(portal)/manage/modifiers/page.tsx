'use client'
import { useState, useEffect, useCallback } from 'react'

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

interface AddOnForm {
  name: string
  price: string
}

const emptyForm = (): AddOnForm => ({ name: '', price: '0.00' })

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', width: 420, maxWidth: '95vw', fontFamily: F }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: DARK }}>{title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8,
  padding: '8px 11px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
}

export default function ModifiersPage() {
  const [addOns, setAddOns] = useState<AddOn[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [pageSize] = useState(25)
  const [totalElements, setTotalElements] = useState(0)
  const [editing, setEditing] = useState<AddOn | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<AddOnForm>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<AddOnForm>>({})
  const [confirm, setConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null)

  const loadAddOns = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/restaurant/add-ons?page=${page}&size=${pageSize}`)
      if (res.ok) {
        const d = await res.json()
        setAddOns(d.content || [])
        setTotalElements(d.totalElements || 0)
      }
    } finally { setLoading(false) }
  }, [page, pageSize])

  useEffect(() => { loadAddOns() }, [loadAddOns])

  function openCreate() {
    setForm(emptyForm())
    setErrors({})
    setCreating(true)
    setEditing(null)
  }

  function openEdit(a: AddOn) {
    setForm({ name: a.name, price: a.price.toFixed(2) })
    setErrors({})
    setEditing(a)
    setCreating(false)
  }

  function closeModal() {
    setCreating(false)
    setEditing(null)
  }

  function validate(): boolean {
    const e: Partial<AddOnForm> = {}
    if (!form.name.trim()) e.name = 'Name is required'
    if (!/^[0-9]*[.]?[0-9]*$/.test(form.price) || form.price === '') e.price = 'Invalid price'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSave() {
    if (!validate()) return
    setSaving(true)
    const body = { name: form.name.trim(), price: parseFloat(form.price) || 0 }
    try {
      if (editing) {
        await fetch(`/api/restaurant/add-ons/${editing.reference}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      } else {
        await fetch('/api/restaurant/add-ons', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      }
      closeModal()
      loadAddOns()
    } finally { setSaving(false) }
  }

  function ask(message: string, onConfirm: () => void) {
    setConfirm({ message, onConfirm })
  }

  async function handleDelete(ref: string, name: string) {
    ask(`Delete modifier "${name}"? This cannot be undone.`, async () => {
      setConfirm(null)
      await fetch(`/api/restaurant/add-ons/${ref}`, { method: 'DELETE' })
      loadAddOns()
    })
  }

  async function handleClone(ref: string) {
    await fetch(`/api/restaurant/add-ons/${ref}/clone`, { method: 'POST' })
    loadAddOns()
  }

  async function handleArchive(a: AddOn) {
    const newArchived = !a.achived
    await fetch(`/api/restaurant/add-ons/${a.reference}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: a.name, price: a.price, archived: newArchived, visible: newArchived ? false : a.visible }),
    })
    loadAddOns()
  }

  const totalPages = Math.ceil(totalElements / pageSize)

  const thStyle: React.CSSProperties = { textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#888', padding: '10px 12px', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
  const tdStyle: React.CSSProperties = { padding: '12px', fontSize: 13, color: DARK, verticalAlign: 'middle' }

  const isOpen = creating || !!editing

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Modifier Library</h1>
        <button
          onClick={openCreate}
          style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}
        >
          + Create Modifier
        </button>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading...</div>
        ) : addOns.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No modifiers yet. Create your first modifier.</div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#fafafa' }}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Price</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {addOns.map((a, i) => (
                  <tr key={a.reference} style={{ borderTop: i > 0 ? '1px solid #f5f5f5' : undefined }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {a.name}
                      {a.achived && <span style={{ marginLeft: 8, fontSize: 10, background: '#f0f0f4', color: '#888', borderRadius: 4, padding: '2px 6px', fontWeight: 500 }}>Archived</span>}
                    </td>
                    <td style={tdStyle}>${a.price.toFixed(2)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <ActionBtn title="Edit" onClick={() => openEdit(a)}>Edit</ActionBtn>
                        <ActionBtn title="Clone" onClick={() => handleClone(a.reference)}>⧉</ActionBtn>
                        <ActionBtn title={a.achived ? 'Unarchive' : 'Archive'} onClick={() => handleArchive(a)}>
                          {a.achived ? '↩' : '🗄'}
                        </ActionBtn>
                        <ActionBtn title="Delete" red onClick={() => handleDelete(a.reference, a.name)}>✕</ActionBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid #f0f0f0' }}>
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: F, opacity: page === 0 ? 0.4 : 1 }}
                >
                  Prev
                </button>
                <span style={{ fontSize: 12, color: '#666' }}>{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontFamily: F, opacity: page >= totalPages - 1 ? 0.4 : 1 }}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {isOpen && (
        <Modal title={editing ? 'Edit Modifier' : 'Create Modifier'} onClose={closeModal}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 }}>Name *</label>
            <input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Modifier name" />
            {errors.name && <div style={{ fontSize: 11, color: '#E53935', marginTop: 3 }}>{errors.name}</div>}
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 5 }}>Price *</label>
            <input
              style={inputStyle}
              value={form.price}
              onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
              placeholder="0.00"
              pattern="^[0-9]*[.]?[0-9]*$"
            />
            {errors.price && <div style={{ fontSize: 11, color: '#E53935', marginTop: 3 }}>{errors.price}</div>}
          </div>
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
