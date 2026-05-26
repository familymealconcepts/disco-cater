'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface ScrapedRestaurant {
  id: string
  name: string
  url?: string
  created_at?: string
  status?: string
}

const STATUS_OPTIONS = ['', 'PENDING', 'INPROGRESS', 'COMPLETED', 'ERRORED']

function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d }
}

function statusPill(s?: string): React.CSSProperties {
  const upper = (s || '').toUpperCase()
  const colors =
    upper === 'COMPLETED' ? { bg: '#E8F5E9', fg: '#2E7D32' }
    : upper === 'INPROGRESS' || upper === 'IN_PROGRESS' ? { bg: '#FFF8E1', fg: '#B07000' }
    : upper === 'ERRORED' || upper === 'ERROR' ? { bg: '#FFF0F0', fg: '#C62828' }
    : { bg: '#F3F4F6', fg: '#555' }
  return {
    display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 11,
    fontWeight: 600, background: colors.bg, color: colors.fg,
  }
}

export default function BulkImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [rows, setRows] = useState<ScrapedRestaurant[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const params2 = new URLSearchParams()
    if (page > 0) params2.set('page', String(page))
    params2.set('size', String(pageSize))
    if (search) params2.set('search', search)
    if (statusFilter) params2.set('status', statusFilter)
    const res = await fetch(`/api/admin/bulk-import/locations/${id}/restaurants?${params2}`)
    if (!res.ok) {
      const d = await res.json().catch(() => null)
      setError(d?.error || 'Failed to load restaurants')
      setRows([]); setTotal(0)
    } else {
      const d = await res.json()
      const arr: ScrapedRestaurant[] = Array.isArray(d) ? d : (d.content || d.data || [])
      const t = Array.isArray(d) ? d.length : (d.totalElements ?? d.total ?? arr.length)
      setRows(arr)
      setTotal(t)
    }
    setLoading(false)
  }, [id, page, pageSize, search, statusFilter])

  useEffect(() => { load() }, [load])

  async function retryRestaurant(r: ScrapedRestaurant) {
    const res = await fetch(`/api/admin/bulk-import/restaurants/${r.id}/retry`, { method: 'PATCH' })
    if (res.ok) {
      // Optimistic flip to INPROGRESS
      setRows(prev => prev.map(x => x.id === r.id ? { ...x, status: 'INPROGRESS' } : x))
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <Link href="/admin/manage-restaurants/bulk-import-menu" style={{ fontSize: 12, color: BLUE, textDecoration: 'none' }}>← All bulk imports</Link>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '8px 0 16px' }}>Imported Restaurants</h1>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginBottom: 14 }}>
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0) }} style={selectSt}>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        <input type="text" placeholder="Search…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 240 }} />
      </div>

      {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>URL</th>
              <th style={colHead}>Created</th>
              <th style={colHead}>Status</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={5} style={{ ...cell, textAlign: 'center', color: '#999' }}>No restaurants for this location.</td></tr>}
            {!loading && rows.map(r => (
              <tr key={r.id}>
                <td style={{ ...cell, fontWeight: 500 }}>{r.name}</td>
                <td style={cell}>{r.url ? <a href={r.url} target="_blank" rel="noreferrer" style={{ color: BLUE, textDecoration: 'none' }}>open ↗</a> : '—'}</td>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(r.created_at)}</td>
                <td style={cell}><span style={statusPill(r.status)}>{r.status}</span></td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  {(r.status || '').toUpperCase() === 'ERRORED' && (
                    <button onClick={() => retryRestaurant(r)} style={linkBtn}>Retry</button>
                  )}
                </td>
              </tr>
            ))}
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
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 12, fontFamily: F, padding: '4px 8px' }
