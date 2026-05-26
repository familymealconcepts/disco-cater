'use client'
import { useState, useEffect, useCallback } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

interface Order {
  orderReference: string
  restaurantReference: string
  restaurantName: string
  restaurantTimezone?: string
  createdDate: string
  orderDate: string
  orderTime: string
  orderType: string
  orderStatus: string
  total: number
  nashDeliveryPickupEta?: string
  nashDeliveryDropoffEta?: string
  orderNumber?: number
}

const STATUS_OPTIONS = ['DUE', 'PAID', 'UNPAID', 'COMPLETED', 'CANCELED', 'REFUND', 'PARTIAL_REFUND', 'VOID', 'EXPIRED', 'REOPEN', 'RESERVED']

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}
function fmtDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return d }
}
function fmtTime(t?: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
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
    if (fromDate) params.set('fromDate', fromDate)
    if (toDate) params.set('toDate', toDate)
    params.append('sort', 'createdDate,desc')
    const res = await fetch(`/api/admin/orders?${params}`)
    if (res.ok) {
      const d = await res.json()
      setOrders(d.content || [])
      setTotal(d.totalElements || 0)
    } else {
      setOrders([])
      setTotal(0)
    }
    setLoading(false)
  }, [page, pageSize, search, fromDate, toDate])

  useEffect(() => { load() }, [load])

  async function changeStatus(o: Order, status: string) {
    if (status === o.orderStatus) return
    setOrders(prev => prev.map(x => x.orderReference === o.orderReference ? { ...x, orderStatus: status } : x))
    const res = await fetch(`/api/admin/orders/${o.orderReference}/status?status=${status}&restaurantReference=${o.restaurantReference}`, {
      method: 'PUT',
    })
    if (!res.ok) load()
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Orders</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(0) }} style={inputSt} />
          <span style={{ color: '#888' }}>→</span>
          <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(0) }} style={inputSt} />
          <input type="text" placeholder="Search…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 240 }} />
        </div>
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
          <thead>
            <tr>
              <th style={colHead}>Received</th>
              <th style={colHead}>Restaurant</th>
              <th style={colHead}>Order #</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Total</th>
              <th style={colHead}>Order Time</th>
              <th style={colHead}>Type</th>
              <th style={colHead}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !orders.length && <tr><td colSpan={7} style={{ ...cell, textAlign: 'center', color: '#999' }}>No orders.</td></tr>}
            {!loading && orders.map(o => (
              <tr key={o.orderReference}>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(o.createdDate)}</td>
                <td style={cell}>{o.restaurantName}</td>
                <td style={cell}>{o.orderNumber ? `#${o.orderNumber}` : '—'}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmtCurrency(o.total)}</td>
                <td style={cell}>{fmtDate(o.orderDate)} {fmtTime(o.orderTime)}</td>
                <td style={cell}>{o.orderType}</td>
                <td style={cell}>
                  <select value={o.orderStatus} onChange={e => changeStatus(o, e.target.value)} style={smallSelect}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>{total} order{total === 1 ? '' : 's'}</div>
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

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
// Suppress unused-variable warning if BLUE is unreferenced after edits.
void BLUE
