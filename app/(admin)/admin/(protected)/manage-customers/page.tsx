'use client'
import { useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Customer {
  customerReference: string
  username: string
  email: string
  phoneNumber?: string
  numberOfOrders: number
  totalspend: number
  sourceoforder?: string
}

// Personal email providers → "Social". Anything else → "Corporate".
// (docs/admin-customers-filters-audit.md B.3)
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'msn.com', 'live.com', 'mac.com', 'ymail.com', 'rocketmail.com',
  'googlemail.com', 'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net', 'optonline.net',
])
function isSocial(email?: string): boolean {
  const d = (email || '').split('@')[1]?.toLowerCase().trim()
  return !!d && PERSONAL_DOMAINS.has(d)
}
function custType(email?: string): 'Corporate' | 'Social' {
  return isSocial(email) ? 'Social' : 'Corporate'
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}

const MAX_PAGES = 50
const FETCH_SIZE = 200

function CustomersInner() {
  const router = useRouter()
  const sp = useSearchParams()

  // Server-side filters (re-fetch FM): name search + last-order date range.
  const [searchInput, setSearchInput] = useState(sp.get('search') || '')
  const [search, setSearch] = useState(sp.get('search') || '')
  const [fromDate, setFromDate] = useState(sp.get('fromDate') || '')
  const [toDate, setToDate] = useState(sp.get('toDate') || '')
  // Client-side filters.
  const [type, setType] = useState<'all' | 'corporate' | 'social'>((sp.get('type') as 'corporate' | 'social') || 'all')
  const [minOrders, setMinOrders] = useState(sp.get('minOrders') || '')
  const [maxOrders, setMaxOrders] = useState(sp.get('maxOrders') || '')

  const [rows, setRows] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)

  // Debounce the name search box.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Persist filters to the URL (deep-linkable / survives reload).
  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (type !== 'all') params.set('type', type)
    if (minOrders) params.set('minOrders', minOrders)
    if (maxOrders) params.set('maxOrders', maxOrders)
    if (fromDate) params.set('fromDate', fromDate)
    if (toDate) params.set('toDate', toDate)
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [search, type, minOrders, maxOrders, fromDate, toDate, router])

  // Fetch the FULL matching set (all pages, capped) so client filters + export
  // operate over everything, not one server page. Server filters: search + date.
  const load = useCallback(async () => {
    setLoading(true)
    const url = (p: number) => {
      const params = new URLSearchParams()
      if (p > 0) params.set('page', String(p))
      params.set('size', String(FETCH_SIZE))
      if (search) params.set('search', search)
      if (fromDate) params.set('fromDate', fromDate)
      if (toDate) params.set('toDate', toDate)
      return `/api/admin/customers?${params}`
    }
    try {
      const first = await fetch(url(0)).then(r => (r.ok ? r.json() : null))
      if (!first) { setRows([]); setLoading(false); return }
      let all: Customer[] = first.content || []
      const totalPages = Math.min(first.totalPages ?? 1, MAX_PAGES)
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetch(url(i + 1)).then(r => (r.ok ? r.json() : null))),
        )
        for (const pg of rest) if (pg?.content) all = all.concat(pg.content)
      }
      setRows(all)
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [search, fromDate, toDate])

  useEffect(() => { load() }, [load])
  // Reset to first page whenever the result set changes.
  useEffect(() => { setPage(0) }, [search, fromDate, toDate, type, minOrders, maxOrders, pageSize])

  const filtered = useMemo(() => rows.filter(r => {
    if (type === 'corporate' && isSocial(r.email)) return false
    if (type === 'social' && !isSocial(r.email)) return false
    const n = r.numberOfOrders ?? 0
    if (minOrders !== '' && n < Number(minOrders)) return false
    if (maxOrders !== '' && n > Number(maxOrders)) return false
    return true
  }), [rows, type, minOrders, maxOrders])

  const filtersActive = !!search || !!fromDate || !!toDate || type !== 'all' || minOrders !== '' || maxOrders !== ''
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize)

  function clearAll() {
    setSearchInput(''); setSearch(''); setFromDate(''); setToDate('')
    setType('all'); setMinOrders(''); setMaxOrders('')
  }

  // Export reflects the CURRENT filtered set (all of it, not just the page).
  function exportCsv() {
    const headers = ['Name', 'Email', 'Phone', '# Orders', 'Total Spend', 'Source', 'Type']
    const body = filtered.map(r => [
      r.username, r.email, r.phoneNumber || '',
      String(r.numberOfOrders ?? 0), String(r.totalspend ?? 0),
      r.sourceoforder || '', custType(r.email),
    ])
    const csv = [headers, ...body]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filtersActive ? 'customers-filtered.csv' : 'customers.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Customers</h1>
        <button onClick={exportCsv} disabled={!filtered.length} style={{ ...primaryBtn, opacity: filtered.length ? 1 : 0.5 }}>
          Export CSV{filtersActive ? ' (filtered)' : ''}
        </button>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input type="text" placeholder="Search by name…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 200 }} />
        <select value={type} onChange={e => setType(e.target.value as 'all' | 'corporate' | 'social')} style={selectSt} aria-label="Type">
          <option value="all">All types</option>
          <option value="corporate">Corporate</option>
          <option value="social">Social</option>
        </select>
        <span style={chipLabel}>Orders</span>
        <input type="number" min={0} placeholder="min" value={minOrders} onChange={e => setMinOrders(e.target.value)} style={{ ...inputSt, width: 70 }} />
        <input type="number" min={0} placeholder="max" value={maxOrders} onChange={e => setMaxOrders(e.target.value)} style={{ ...inputSt, width: 70 }} />
        <span style={chipLabel}>Last order</span>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inputSt} aria-label="From date" />
        <span style={{ color: '#aaa' }}>–</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={inputSt} aria-label="To date" />
        {filtersActive && (
          <button onClick={clearAll} style={clearBtn}>Clear All</button>
        )}
      </div>

      {filtersActive && (
        <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
          Showing {filtered.length} of {rows.length} customers
          {loading && ' · loading…'}
        </div>
      )}

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={colHead}>Name</th>
              <th style={colHead}>Email</th>
              <th style={colHead}>Phone</th>
              <th style={colHead}>Type</th>
              <th style={{ ...colHead, textAlign: 'right' }}># Orders</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Total Spend</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !pageRows.length && <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: '#999' }}>No customers.</td></tr>}
            {!loading && pageRows.map(r => (
              <tr key={r.customerReference}>
                <td style={{ ...cell, fontWeight: 500 }}>{r.username}</td>
                <td style={{ ...cell, color: '#555' }}>{r.email}</td>
                <td style={{ ...cell, color: '#666' }}>{r.phoneNumber || '—'}</td>
                <td style={{ ...cell, color: '#666' }}>{custType(r.email)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{r.numberOfOrders ?? 0}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(r.totalspend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{filtered.length} customer{filtered.length === 1 ? '' : 's'}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#666' }}>
          <span>Per page:</span>
          <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} style={smallSelect}>
            {[25, 50, 100, 250].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>
    </div>
  )
}

export default function AdminCustomersPage() {
  return (
    <Suspense fallback={<div style={{ padding: 32, fontFamily: F, color: '#999' }}>Loading…</div>}>
      <CustomersInner />
    </Suspense>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const chipLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
const clearBtn: React.CSSProperties = { background: 'transparent', border: '1px solid #ddd', borderRadius: 8, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: '#555' }
const primaryBtn: React.CSSProperties = { padding: '9px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }
