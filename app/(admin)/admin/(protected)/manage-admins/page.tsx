'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const PAGE_BG = '#F7F8FC'

interface SysAdmin {
  reference: string
  firstName: string
  lastName?: string
  email: string
  phoneNumber?: string
  locations?: number
  restaurants?: { reference: string }[]
}

type FormState = Pick<SysAdmin, 'firstName' | 'lastName' | 'email' | 'phoneNumber'> & { reference?: string }

export default function ManageSystemAdminsPage() {
  const [rows, setRows] = useState<SysAdmin[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    if (search) params.set('search', search)
    const res = await fetch(`/api/admin/system-admins?${params}`)
    if (res.ok) {
      const d = await res.json()
      setRows(d.content || [])
      setTotal(d.totalElements || 0)
    } else {
      setRows([])
      setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!editing) return
    if (!editing.firstName || !editing.email) { setError('First name and email required'); return }
    setSaving(true)
    setError('')
    const isNew = !editing.reference
    const res = await fetch(
      isNew ? '/api/admin/system-admins' : `/api/admin/system-admins/${editing.reference}`,
      {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: editing.firstName,
          lastName: editing.lastName || '',
          email: editing.email,
          phoneNumber: editing.phoneNumber || '',
        }),
      }
    )
    setSaving(false)
    if (res.ok) { setEditing(null); load() }
    else { const d = await res.json().catch(() => ({})); setError(d?.error || 'Save failed') }
  }

  async function deleteAdmin(u: SysAdmin) {
    if (!confirm(`Delete system admin ${u.email}?`)) return
    const res = await fetch(`/api/admin/system-admins/${u.reference}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>System Admins</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="text" placeholder="Search…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 240 }} />
          <button onClick={() => setEditing({ firstName: '', lastName: '', email: '', phoneNumber: '' })} style={primaryBtn}>+ Add System Admin</button>
        </div>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Phone</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Locations</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No system admins.</td></tr>}
            {!loading && rows.map(u => (
              <tr key={u.reference}>
                <td style={cell}>{u.firstName} {u.lastName || ''}</td>
                <td style={{ ...cell, color: '#555' }}>{u.email}</td>
                <td style={{ ...cell, color: '#666' }}>{u.phoneNumber || '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{u.locations ?? u.restaurants?.length ?? 0}</td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <button onClick={() => setEditing({ reference: u.reference, firstName: u.firstName, lastName: u.lastName, email: u.email, phoneNumber: u.phoneNumber })} style={linkBtn}>Edit</button>
                  <button onClick={() => deleteAdmin(u)} style={{ ...linkBtn, color: '#E76F51' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} system admin{total === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }} style={smallSelect}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 460, width: '100%', fontFamily: F }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>
              {editing.reference ? 'Edit System Admin' : 'New System Admin'}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={lbl}>First name*</label>
                  <input style={inputSt} value={editing.firstName} onChange={e => setEditing({ ...editing, firstName: e.target.value })} />
                </div>
                <div>
                  <label style={lbl}>Last name</label>
                  <input style={inputSt} value={editing.lastName || ''} onChange={e => setEditing({ ...editing, lastName: e.target.value })} />
                </div>
              </div>
              <div>
                <label style={lbl}>Email*</label>
                <input type="email" style={inputSt} value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Phone</label>
                <input style={inputSt} value={editing.phoneNumber || ''} onChange={e => setEditing({ ...editing, phoneNumber: e.target.value })} placeholder="000-000-0000" />
              </div>
            </div>
            {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 12, fontSize: 13 }}>{error}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button onClick={() => setEditing(null)} disabled={saving} style={secondaryBtn}>Cancel</button>
              <button onClick={save} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <style>{`select:focus, input:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }`}</style>
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%', boxSizing: 'border-box' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: '#6B6EF9', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
const secondaryBtn: React.CSSProperties = { padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
