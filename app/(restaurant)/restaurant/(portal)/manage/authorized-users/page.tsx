'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface AuthUser {
  reference: string
  firstName: string
  lastName?: string
  email: string
  role: string
  createdDate?: string
  locked?: boolean
}

const ROLES = ['ADMIN', 'SYSTEM_ADMIN', 'RESTAURANT_USER', 'USER']

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getDate().toString().padStart(2, '0')}/${dt.getFullYear()}`
  } catch { return d }
}

export default function AuthorizedUsersPage() {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<AuthUser | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), size: String(pageSize) })
    if (search) params.set('search', search)
    const res = await fetch(`/api/restaurant/authorized-users?${params}`)
    if (res.ok) {
      const data = await res.json()
      setUsers(data.content || [])
      setTotal(data.totalElements || 0)
    } else {
      setUsers([])
    }
    setLoading(false)
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  async function saveUser() {
    if (!editing) return
    await fetch(`/api/restaurant/authorized-users/${editing.reference}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: editing.firstName, lastName: editing.lastName, email: editing.email, role: editing.role }),
    })
    setEditing(null)
    load()
  }

  async function resetPassword(u: AuthUser) {
    if (!confirm(`Send password reset email to ${u.email}?`)) return
    await fetch(`/api/restaurant/authorized-users/${u.reference}/reset-password`, { method: 'PUT' })
    alert('Password reset email sent.')
  }

  async function deleteUser(u: AuthUser) {
    if (!confirm(`Delete user ${u.email}? This cannot be undone.`)) return
    await fetch(`/api/restaurant/authorized-users/${u.reference}`, { method: 'DELETE' })
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
  const cell: React.CSSProperties = { padding: '12px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
  const input: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff', width: '100%' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 20px' }}>Authorized Users</h1>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <input type="text" placeholder="Search by name…" value={search} onChange={e => { setPage(0); setSearch(e.target.value) }}
          style={{ ...input, flex: '0 0 280px', width: 'auto' }} />
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#666' }}>{total} user{total === 1 ? '' : 's'}</div>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={colHead}>Name</th>
            <th style={{ ...colHead, width: 130 }}>Role</th>
            <th style={colHead}>Email</th>
            <th style={{ ...colHead, width: 110 }}>Created</th>
            <th style={{ ...colHead, width: 220, textAlign: 'right' }}>Actions</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !users.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No users.</td></tr>}
            {!loading && users.map(u => (
              <tr key={u.reference}>
                <td style={cell}>{u.firstName} {u.lastName || ''}</td>
                <td style={cell}><span style={{ background: '#f0f1ff', color: BLUE, padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>{u.role}</span></td>
                <td style={{ ...cell, color: '#555' }}>{u.email}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(u.createdDate)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <button onClick={() => setEditing(u)} style={btnLink}>Edit</button>
                  <button onClick={() => resetPassword(u)} style={btnLink}>Reset Password</button>
                  <button onClick={() => deleteUser(u)} style={{ ...btnLink, color: '#E76F51' }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => { setPage(0); setPageSize(Number(e.target.value)) }}
            style={{ border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
      </div>

      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 460, width: '90%', fontFamily: F }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 700, color: DARK }}>Edit User</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={lbl}>First name</label>
                <input style={input} value={editing.firstName} onChange={e => setEditing({ ...editing, firstName: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Last name</label>
                <input style={input} value={editing.lastName || ''} onChange={e => setEditing({ ...editing, lastName: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Email</label>
                <input style={input} value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} />
              </div>
              <div>
                <label style={lbl}>Role</label>
                <select style={input} value={editing.role} onChange={e => setEditing({ ...editing, role: e.target.value })}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
              <button onClick={() => setEditing(null)} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>Cancel</button>
              <button onClick={saveUser} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnLink: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px', marginLeft: 4 }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }
