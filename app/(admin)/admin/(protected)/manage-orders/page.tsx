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
  // FM sometimes returns the order value under transactionsTotal instead of
  // total (list-shape vs detail-shape) — fall back to it so legitimate orders
  // don't render as $0.00.
  transactionsTotal?: number
  // 'INVOICE' (email payment link, explains UNPAID) or 'PAYMENT' (card charged).
  paymentMethod?: string
  firstName?: string
  lastName?: string
  email?: string
  nashDeliveryPickupEta?: string
  nashDeliveryDropoffEta?: string
  orderNumber?: number
  // FM wire attribution: "DISCO" (3P, marketplace, lead-gen fee) or
  // "FAMILYMEAL" (1P, restaurant's own direct link). Rendered as a "3P"/"1P"
  // pill; never show the raw value.
  sourceoforder?: string
}

const STATUS_OPTIONS = ['DUE', 'PAID', 'UNPAID', 'COMPLETED', 'CANCELED', 'REFUND', 'PARTIAL_REFUND', 'VOID', 'EXPIRED', 'REOPEN', 'RESERVED']

// Friendly labels for the raw FM enum (mirrors the restaurant portal orders
// page). Falls back to the raw value for any status not mapped here.
const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', PAID: 'Paid', UNPAID: 'Unpaid', COMPLETED: 'Completed',
  CANCELED: 'Canceled', REFUND: 'Refunded', PARTIAL_REFUND: 'Partial Refund',
  VOID: 'Void', EXPIRED: 'Expired', RESERVED: 'Reserved', REOPEN: 'Reopened',
  IN_PROGRESS: 'In Progress',
}
const statusLabel = (s: string) => STATUS_LABEL[s] || s

// 3P / 1P attribution pill. "DISCO" → 3P (Disco Blue), "FAMILYMEAL" → 1P
// (gray). Small + subtle, no emoji. Renders nothing for unknown/absent values.
// Style matches the restaurant admin orders table exactly.
function SourcePill({ source }: { source?: string }) {
  if (source !== 'DISCO' && source !== 'FAMILYMEAL') return null
  const is3P = source === 'DISCO'
  return (
    <span style={{
      display: 'inline-block', padding: '1px 5px', borderRadius: 4,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.02em', verticalAlign: 'middle',
      color: '#fff', background: is3P ? '#5B6FE8' : '#9090C8',
    }}
      title={is3P ? 'Third-party (marketplace)' : 'First-party (direct link)'}>
      {is3P ? '3P' : '1P'}
    </span>
  )
}

// Amber "Invoice" pill — shown for paymentMethod === 'INVOICE' to explain why
// an order may be UNPAID. Card payments (PAYMENT) are the default and get no pill.
function InvoicePill({ paymentMethod }: { paymentMethod?: string }) {
  if (paymentMethod !== 'INVOICE') return null
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 5px', borderRadius: 4,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.02em', verticalAlign: 'middle',
      color: DARK, background: '#EFB84A',
    }}
      title="Invoice — payment link sent, not yet paid">
      Invoice
    </span>
  )
}

// Muted "Draft" badge — flags a likely abandoned cart (zero total, still in an
// early status, and not an invoice order which legitimately starts at $0).
function DraftBadge({ order }: { order: Order }) {
  const value = order.total ?? order.transactionsTotal ?? 0
  const isDraft = value === 0 &&
    (order.orderStatus === 'RESERVED' || order.orderStatus === 'UNPAID') &&
    order.paymentMethod !== 'INVOICE'
  if (!isDraft) return null
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 5px', borderRadius: 4,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.02em', verticalAlign: 'middle',
      color: '#999', background: '#f0f0f0',
    }}
      title="Likely abandoned cart — initiated but never paid">
      Draft
    </span>
  )
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0)
}
// firstName + lastName, falling back to email, then an em dash.
function customerName(o: Order) {
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim()
  return name || o.email || '—'
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
              <th style={colHead}>Placed</th>
              <th style={colHead}>Restaurant</th>
              <th style={colHead}>Customer</th>
              <th style={colHead}>Order #</th>
              <th style={{ ...colHead, textAlign: 'right' }}>Total</th>
              <th style={colHead}>Order Time</th>
              <th style={colHead}>Type</th>
              <th style={colHead}>Source</th>
              <th style={colHead}>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading…</td></tr>}
            {!loading && !orders.length && <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', color: '#999' }}>No orders.</td></tr>}
            {!loading && orders.map(o => (
              <tr key={o.orderReference}>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(o.createdDate)}</td>
                <td style={cell}>{o.restaurantName}</td>
                <td style={cell}>{customerName(o)}</td>
                <td style={cell}>
                  {o.orderNumber ? `#${o.orderNumber}` : '—'}
                  <DraftBadge order={o} />
                </td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>
                  {fmtCurrency(o.total ?? o.transactionsTotal ?? 0)}
                  <InvoicePill paymentMethod={o.paymentMethod} />
                </td>
                <td style={cell}>{fmtDate(o.orderDate)} {fmtTime(o.orderTime)}</td>
                <td style={cell}>{o.orderType}</td>
                <td style={cell}><SourcePill source={o.sourceoforder} /></td>
                <td style={cell}>
                  <select value={o.orderStatus} onChange={e => changeStatus(o, e.target.value)} style={smallSelect}>
                    {STATUS_OPTIONS.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
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
