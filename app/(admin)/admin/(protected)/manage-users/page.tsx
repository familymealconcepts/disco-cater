'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface User {
  reference: string
  firstName: string
  lastName?: string
  email: string
  phoneNumber?: string
  enabled: boolean
  role: string
  createdDate?: string
  lastOrder?: string
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getDate().toString().padStart(2, '0')}/${dt.getFullYear()}`
  } catch { return d }
}

export default function AdminUsersPage() {
  const [rows, setRows] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)

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
    const res = await fetch(`/api/admin/users?${params}`)
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

  async function toggleEnabled(u: User) {
    const next = !u.enabled
    setRows(prev => prev.map(x => x.reference === u.reference ? { ...x, enabled: next } : x))
    const res = await fetch(`/api/admin/users/${u.reference}/disable?isEnabled=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x.reference === u.reference ? { ...x, enabled: !next } : x))
  }

  async function deleteUser(u: User) {
    if (!confirm(`Delete ${u.email}?`)) return
    const res = await fetch(`/api/admin/users/${u.reference}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Users</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="text" placeholder="Search…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 240 }} />
          <button onClick={() => setAddOpen(true)}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
            + Add User
          </button>
        </div>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Role</th>
              <th style={colHead}>Created</th>
              <th style={colHead}>Last Order</th>
              <th style={colHead}>Enabled</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No users.</td></tr>}
            {!loading && rows.map(u => (
              <tr key={u.reference}>
                <td style={cell}>{u.firstName} {u.lastName || ''}</td>
                <td style={{ ...cell, color: '#555' }}>{u.email}</td>
                <td style={cell}><span style={{ background: '#f0f1ff', color: BLUE, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{u.role}</span></td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(u.createdDate)}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(u.lastOrder)}</td>
                <td style={cell}>
                  <button onClick={() => toggleEnabled(u)} style={u.enabled ? toggleOn : toggleOff}>
                    {u.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <button onClick={() => deleteUser(u)} style={{ ...linkBtn, color: '#E76F51' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddUserDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); setPage(0); load() }}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} user{total === 1 ? '' : 's'}</div>
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
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
const toggleOn: React.CSSProperties = { background: '#E8F5E9', color: '#2E7D32', border: 'none', padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer' }
const toggleOff: React.CSSProperties = { background: '#FFF0F0', color: '#C62828', border: 'none', padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer' }

// ── Add User modal — Section B in docs/fm-super-admin-audit.md ─────────────
// Mirrors FM's UserService.create payload. SUPER_ADMIN creates regular
// USER (diner) accounts here. System-admin staff get created from the
// separate manage-admins page; restaurant staff from manage-restaurants.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function AddUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!firstName.trim()) { setErr('First name required'); return }
    if (!lastName.trim()) { setErr('Last name required'); return }
    if (!EMAIL_RE.test(email.trim())) { setErr('Valid email required'); return }
    if (!phoneNumber.trim()) { setErr('Phone number required'); return }
    setSubmitting(true); setErr(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phoneNumber: phoneNumber.trim(),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        throw new Error(d?.error || `HTTP ${res.status}`)
      }
      onCreated()
    } catch (e) {
      setErr((e as Error).message || 'Unable to create user')
    } finally {
      setSubmitting(false)
    }
  }

  const fieldInput: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff',
  }
  const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }

  return (
    <div onClick={() => !submitting && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,15,40,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 480, width: '100%', fontFamily: F }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: DARK }}>Add User</h2>
        {err && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 13, color: '#DC2626' }}>{err}</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div><label style={lbl}>First name *</label><input style={fieldInput} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
          <div><label style={lbl}>Last name *</label><input style={fieldInput} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Email *</label>
          <input style={fieldInput} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="user@example.com" />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>Phone *</label>
          <input style={fieldInput} value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="000-000-0000" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={submitting}
            style={{ background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: F }}>Cancel</button>
          <button onClick={submit} disabled={submitting}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1, fontFamily: F }}>
            {submitting ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </div>
    </div>
  )
}
