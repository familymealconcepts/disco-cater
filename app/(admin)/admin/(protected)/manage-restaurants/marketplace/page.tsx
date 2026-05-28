'use client'
import { useState, useEffect, useCallback } from 'react'
import EditRestaurantDialog from '../EditRestaurantDialog'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Restaurant {
  reference: string
  businessName: string
  url?: string
  blocked?: boolean
  adminName?: string
  admin?: { firstName?: string; lastName?: string; email?: string }
  createdDate?: string
}

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return `${(dt.getMonth() + 1).toString().padStart(2, '0')}/${dt.getDate().toString().padStart(2, '0')}/${dt.getFullYear()}`
  } catch { return d }
}

export default function MarketplaceRestaurantsPage() {
  const [rows, setRows] = useState<Restaurant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [editRef, setEditRef] = useState<string | null>(null)

  // Mirrors restaurant-table.component.ts blocked(): POST
  // /api/admin/restaurants/manage/block/{ref}?block={bool}. FM uses
  // this single endpoint for both Ordering and Marketplace lists; the
  // checkbox column was missing on our marketplace page (D.2 from the
  // audit). Optimistic toggle; revert if FM fails.
  async function toggleBlocked(r: Restaurant) {
    const next = !r.blocked
    setToggling(r.reference)
    setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, blocked: next } : x))
    try {
      const res = await fetch(`/api/admin/restaurants/${r.reference}/block?block=${next}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      setRows(prev => prev.map(x => x.reference === r.reference ? { ...x, blocked: !next } : x))
      alert('Could not update block status. Please try again.')
    } finally {
      setToggling(null)
    }
  }

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
    const res = await fetch(`/api/admin/restaurants/marketplace?${params}`)
    if (res.ok) {
      const d = await res.json()
      setRows(d.content || [])
      setTotal(d.totalElements || 0)
    } else { setRows([]); setTotal(0) }
    setLoading(false)
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Restaurants — Marketplace</h1>
        <input type="text" placeholder="Search…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 240 }} />
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...colHead, width: 80 }}>Visible</th>
              <th style={colHead}>Restaurant</th>
              <th style={colHead}>Admin</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Created</th>
              <th style={colHead}>Checkout Page</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No marketplace restaurants.</td></tr>}
            {!loading && rows.map(r => {
              const adminName = r.adminName || `${r.admin?.firstName || ''} ${r.admin?.lastName || ''}`.trim()
              return (
                <tr key={r.reference}>
                  <td style={cell}>
                    <label title={r.blocked ? 'Hidden from marketplace' : 'Visible on marketplace'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: toggling === r.reference ? 'wait' : 'pointer', fontSize: 12, color: r.blocked ? '#E76F51' : '#1D9E75', fontWeight: 600 }}>
                      <input type="checkbox"
                        checked={!r.blocked}
                        disabled={toggling === r.reference}
                        onChange={() => toggleBlocked(r)}
                        style={{ accentColor: BLUE, cursor: toggling === r.reference ? 'wait' : 'pointer' }} />
                      {r.blocked ? 'Hidden' : 'Visible'}
                    </label>
                  </td>
                  <td style={{ ...cell, fontWeight: 600 }}>{r.businessName}</td>
                  <td style={{ ...cell, color: '#555' }}>{adminName || '—'}</td>
                  <td style={{ ...cell, color: '#555' }}>{r.admin?.email || '—'}</td>
                  <td style={{ ...cell, color: '#666' }}>{fmtDate(r.createdDate)}</td>
                  <td style={cell}>{r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none' }}>open ↗</a> : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>
                    <button title="Edit" onClick={() => setEditRef(r.reference)}
                      style={{ background: '#f5f5f8', border: '1px solid #e8e8ee', borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: F }}>✎</button>
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

      {editRef && (
        <EditRestaurantDialog
          restaurantRef={editRef}
          onClose={() => setEditRef(null)}
          onSaved={() => { setEditRef(null); load() }}
        />
      )}
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
