'use client'
import { useState, useEffect, useCallback } from 'react'
import AddRestaurantDialog from './AddRestaurantDialog'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'] as const

interface Restaurant {
  reference: string
  businessName: string
  url?: string
  blocked?: boolean
  nashAllowed?: boolean
  shipdayEnabled?: boolean
  holdPayments?: boolean
  onlineOrderingAllowed?: boolean
  restaurantStatus?: string
  createdDate?: string
  adminName?: string
  adminEmail?: string
  admin?: { firstName?: string; lastName?: string; email?: string }
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    const yy = String(dt.getFullYear()).slice(-2)
    return `${mm}/${dd}/${yy}`
  } catch { return d }
}

function Toggle({ checked, onChange, disabled, color = BLUE }: { checked: boolean; onChange: () => void; disabled?: boolean; color?: string }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onChange}
      aria-pressed={checked}
      style={{
        width: 32, height: 18, borderRadius: 9, padding: 0,
        background: checked ? color : '#d9d9d9',
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', transition: 'background 0.15s',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, background: '#fff', borderRadius: '50%',
        transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
      }} />
    </button>
  )
}

export default function RestaurantsOrderingPage() {
  const [rows, setRows] = useState<Restaurant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (page > 0) params.set('page', String(page))
    params.set('size', String(pageSize))
    if (search) params.set('search', search)
    if (statusFilter) params.set('restaurantStatus', statusFilter)
    const res = await fetch(`/api/admin/restaurants?${params}`)
    if (res.ok) {
      const d = await res.json()
      setRows(d.content || [])
      setTotal(d.totalElements || 0)
    } else {
      setError('Failed to load restaurants')
      setRows([])
      setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search, statusFilter])

  useEffect(() => { load() }, [load])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(''), 2500)
  }

  async function toggleBlock(r: Restaurant) {
    const next = !r.blocked
    setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, blocked: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/block?block=${next}`, { method: 'POST' })
    if (!res.ok) {
      setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, blocked: !next } : x))
    } else {
      showToast(`${r.businessName} ${next ? 'blocked' : 'unblocked'}`)
    }
  }

  async function toggleNash(r: Restaurant) {
    const next = !r.nashAllowed
    setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, nashAllowed: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/nash?nashAllowed=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, nashAllowed: !next } : x))
  }

  async function toggleShipday(r: Restaurant) {
    const next = !r.shipdayEnabled
    setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, shipdayEnabled: next } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/shipday?shipdayEnabled=${next}`, { method: 'PATCH' })
    if (!res.ok) setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, shipdayEnabled: !next } : x))
  }

  async function changeStatus(r: Restaurant, status: string) {
    if (status === r.restaurantStatus) return
    setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, restaurantStatus: status } : x))
    const res = await fetch(`/api/admin/restaurants/${r.reference}/status?status=${status}`, { method: 'POST' })
    if (res.ok) showToast(`${r.businessName} → ${status}`)
    else load() // revert by reload
  }

  async function resetPassword(r: Restaurant) {
    if (!confirm(`Send password reset for ${r.adminEmail || r.admin?.email}?`)) return
    const res = await fetch(`/api/admin/restaurants/${r.reference}/reset-password`, { method: 'PUT' })
    if (res.ok) showToast('Password reset email sent')
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const [addOpen, setAddOpen] = useState(false)

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, gap: 16, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurants — Ordering</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }} style={{ ...selectSt, minWidth: 160 }}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="text" placeholder="Search…" value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ ...inputSt, width: 240 }}
          />
          <button onClick={() => setAddOpen(true)}
            style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, whiteSpace: 'nowrap' }}>
            + Add Restaurant
          </button>
        </div>
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={colHead}>Blocked</th>
              <th style={colHead}>Restaurant</th>
              <th style={colHead}>Admin</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Created</th>
              <th style={colHead}>URL</th>
              <th style={colHead}>Status</th>
              <th style={colHead}>Nash</th>
              <th style={colHead}>Shipday</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={10} style={{ ...cell, textAlign: 'center', color: '#999' }}>No restaurants.</td></tr>}
            {!loading && rows.map(r => {
              const adminName = r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
              const adminEmail = r.adminEmail || r.admin?.email || ''
              return (
                <tr key={r.reference}>
                  <td style={cell}>
                    <Toggle checked={!!r.blocked} onChange={() => toggleBlock(r)} color="#E76F51" />
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>{r.businessName}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminName || '—'}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminEmail}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(r.createdDate)}</td>
                  <td style={cell}>
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none' }}>open ↗</a> : '—'}
                  </td>
                  <td style={cell}>
                    <select value={r.restaurantStatus || ''} onChange={e => changeStatus(r, e.target.value)} style={smallSelect}>
                      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td style={cell}><Toggle checked={!!r.nashAllowed} onChange={() => toggleNash(r)} /></td>
                  <td style={cell}><Toggle checked={!!r.shipdayEnabled} onChange={() => toggleShipday(r)} /></td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button onClick={() => resetPassword(r)} style={linkBtn}>Reset PW</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} restaurant{total === 1 ? '' : 's'}</div>
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

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, background: DARK, color: '#fff',
          padding: '10px 16px', borderRadius: 8, fontSize: 13, zIndex: 400,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>{toast}</div>
      )}

      {/* Visual hint for the gold theme — show on hover of status select */}
      <style>{`
        select:focus { outline: 2px solid ${GOLD}; outline-offset: 1px; }
      `}</style>

      {addOpen && (
        <AddRestaurantDialog
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); showToast('Restaurant created'); setPage(0); load() }}
        />
      )}
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
