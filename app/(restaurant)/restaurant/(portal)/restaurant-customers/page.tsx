'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Customer {
  customerReference: string
  username: string
  email: string
  phoneNumber: string
  numberOfOrders: number
  totalspend: number
  // FM may include a last-order timestamp under one of a few names; read defensively.
  lastOrderDate?: string | null
  lastOrder?: string | null
}

// Personal/consumer email domains → "Social"; everything else → "Corporate".
// Mirrors the admin manage-customers heuristic.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'msn.com', 'live.com', 'mac.com', 'ymail.com', 'rocketmail.com',
  'googlemail.com', 'protonmail.com', 'proton.me', 'comcast.net', 'verizon.net',
  'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'earthlink.net', 'optonline.net',
])
function custType(email?: string): 'Corporate' | 'Social' {
  const d = (email || '').split('@')[1]?.toLowerCase().trim()
  return d && PERSONAL_DOMAINS.has(d) ? 'Social' : 'Corporate'
}
function lastOrderTs(c: Customer): number {
  const raw = c.lastOrderDate || c.lastOrder
  if (!raw) return 0
  const t = new Date(raw).getTime()
  return Number.isNaN(t) ? 0 : t
}
function fmtDate(raw?: string | null): string {
  if (!raw) return '—'
  const t = new Date(raw).getTime()
  if (Number.isNaN(t)) return '—'
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type SortKey = 'name' | 'email' | 'type' | 'orders' | 'lastOrder' | 'spend'

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}

function exportCSV(customers: Customer[]) {
  const header = ['Name', 'Email', 'Type', 'Phone', 'Orders', 'Last Order', 'Total Spend']
  const rows = customers.map(c => [
    c.username,
    c.email,
    custType(c.email),
    c.phoneNumber,
    String(c.numberOfOrders),
    c.lastOrderDate || c.lastOrder || '',
    String(c.totalspend),
  ])
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'customers.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function CustomersPage() {
  const router = useRouter()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(25)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('lastOrder')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [typeFilter, setTypeFilter] = useState<'all' | 'Social' | 'Corporate'>('all')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Filter (by customer type) + sort happen client-side over the loaded page.
  function toggleSort(key: SortKey) {
    if (sortKey === key) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return }
    setSortKey(key)
    // Text columns default A→Z; numeric/date columns default high→recent first.
    setSortDir(key === 'name' || key === 'email' || key === 'type' ? 'asc' : 'desc')
  }

  const displayed = (() => {
    const filtered = typeFilter === 'all' ? customers : customers.filter(c => custType(c.email) === typeFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    const cmp = (a: Customer, b: Customer): number => {
      switch (sortKey) {
        case 'name': return (a.username || '').localeCompare(b.username || '') * dir
        case 'email': return (a.email || '').localeCompare(b.email || '') * dir
        case 'type': return custType(a.email).localeCompare(custType(b.email)) * dir
        case 'orders': return ((a.numberOfOrders ?? 0) - (b.numberOfOrders ?? 0)) * dir
        case 'spend': return ((a.totalspend ?? 0) - (b.totalspend ?? 0)) * dir
        case 'lastOrder': return (lastOrderTs(a) - lastOrderTs(b)) * dir
        default: return 0
      }
    }
    return [...filtered].sort(cmp)
  })()

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕')

  const load = useCallback(async (p = page, s = size, q = search) => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(p), size: String(s) })
    if (q) params.set('search', q)
    const res = await fetch(`/api/restaurant/customers?${params}`)
    if (res.ok) {
      const d = await res.json()
      setCustomers(d.content || [])
      setTotal(d.totalElements || 0)
    }
    setLoading(false)
  }, [page, size, search])

  useEffect(() => { load() }, [load])

  function handleSearchChange(val: string) {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPage(0)
      load(0, size, val)
    }, 400)
  }

  const totalPages = Math.ceil(total / size)

  const colHead: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: '#888',
    padding: '10px 12px', borderBottom: '1px solid #f0f0f0',
    textAlign: 'left', textTransform: 'uppercase', background: '#F7F8FC',
  }
  const sortHead: React.CSSProperties = { ...colHead, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }
  const cell: React.CSSProperties = { fontSize: 13, color: DARK, padding: '12px' }

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Customers</h1>
        <button
          onClick={() => exportCSV(displayed)}
          disabled={displayed.length === 0}
          style={{
            padding: '8px 16px', background: '#fff', border: '1px solid #ddd', borderRadius: 8,
            fontSize: 13, cursor: customers.length === 0 ? 'default' : 'pointer', fontFamily: F,
            color: DARK, fontWeight: 500, opacity: customers.length === 0 ? 0.5 : 1,
          }}
        >
          Export CSV
        </button>
      </div>

      {/* Search + Page size */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
          style={{
            border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px',
            fontSize: 13, fontFamily: F, outline: 'none', minWidth: 220,
          }}
        />
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value as 'all' | 'Social' | 'Corporate')}
          style={{
            border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px',
            fontSize: 13, fontFamily: F, background: '#fff', outline: 'none', color: DARK,
          }}
        >
          <option value="all">All types</option>
          <option value="Corporate">Corporate</option>
          <option value="Social">Social</option>
        </select>
        <select
          value={size}
          onChange={e => { setSize(Number(e.target.value)); setPage(0) }}
          style={{
            border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px',
            fontSize: 13, fontFamily: F, background: '#fff', outline: 'none', color: DARK,
          }}
        >
          {[25, 50, 100, 250].map(n => (
            <option key={n} value={n}>{n} per page</option>
          ))}
        </select>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={sortHead} onClick={() => toggleSort('name')}>Name{sortArrow('name')}</th>
              <th style={sortHead} onClick={() => toggleSort('email')}>Email{sortArrow('email')}</th>
              <th style={sortHead} onClick={() => toggleSort('type')}>Type{sortArrow('type')}</th>
              <th style={colHead}>Phone</th>
              <th style={{ ...sortHead, textAlign: 'right' }} onClick={() => toggleSort('orders')}>Orders{sortArrow('orders')}</th>
              <th style={{ ...sortHead, textAlign: 'right' }} onClick={() => toggleSort('lastOrder')}>Last Order{sortArrow('lastOrder')}</th>
              <th style={{ ...sortHead, textAlign: 'right' }} onClick={() => toggleSort('spend')}>Total Spend{sortArrow('spend')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading…</td></tr>
            )}
            {!loading && displayed.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 32, textAlign: 'center', color: '#aaa', fontSize: 13 }}>No customers found</td></tr>
            )}
            {displayed.map(c => (
              <tr
                key={c.customerReference}
                onClick={() => router.push(`/restaurant/restaurant-customers/${c.customerReference}`)}
                style={{ cursor: 'pointer', borderTop: '1px solid #f5f5f5', transition: 'background 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fafafa')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                <td style={{ ...cell, fontWeight: 500 }}>{c.username || '—'}</td>
                <td style={cell}>{c.email || '—'}</td>
                <td style={cell}>{custType(c.email)}</td>
                <td style={cell}>{c.phoneNumber || '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{c.numberOfOrders ?? 0}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmtDate(c.lastOrderDate || c.lastOrder)}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{fmtCurrency(c.totalspend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
          <div style={{ fontSize: 13, color: '#888' }}>
            {total} customers — page {page + 1} of {totalPages}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setPage(0)} disabled={page === 0}
              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}
            >«</button>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}
            >‹</button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pg = Math.max(0, Math.min(totalPages - 5, page - 2)) + i
              return (
                <button
                  key={pg} onClick={() => setPage(pg)}
                  style={{
                    padding: '6px 10px', border: '1px solid', borderColor: pg === page ? BLUE : '#ddd',
                    borderRadius: 6, background: pg === page ? BLUE : '#fff',
                    color: pg === page ? '#fff' : DARK, cursor: 'pointer', fontSize: 13,
                    fontFamily: F, fontWeight: pg === page ? 700 : 400,
                  }}
                >
                  {pg + 1}
                </button>
              )
            })}
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}
            >›</button>
            <button
              onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
              style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}
            >»</button>
          </div>
        </div>
      )}
    </div>
  )
}
