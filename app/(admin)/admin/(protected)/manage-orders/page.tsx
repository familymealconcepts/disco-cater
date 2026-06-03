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
  // pill; never show the raw value. Also used to detect Direct Entry orders
  // (FAMILYMEAL) for the (DE) type badge.
  sourceoforder?: string
  // Third-party-delivery signals. FM doesn't always type these on the list
  // shape, so they're optional; we also fall back to the Nash courier ETAs
  // (nashDelivery*Eta) which only exist on third-party (dispatched) deliveries.
  deliveryType?: string
  thirdPartyDelivery?: boolean
}

// Friendly labels for the raw FM enum (mirrors the restaurant portal orders
// page). Falls back to the raw value for any status not mapped here.
const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', PAID: 'Paid', UNPAID: 'Unpaid', COMPLETED: 'Completed',
  CANCELED: 'Canceled', REFUND: 'Refunded', PARTIAL_REFUND: 'Partial Refund',
  VOID: 'Void', EXPIRED: 'Expired', RESERVED: 'Reserved', REOPEN: 'Reopened',
  IN_PROGRESS: 'In Progress',
}
const statusLabel = (s: string) => STATUS_LABEL[s] || s

// Subtle pill colors (bg + text) keyed by status family.
const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  DUE: { bg: '#E8ECFB', fg: '#3A4BB0' },       // blue
  REOPEN: { bg: '#E8ECFB', fg: '#3A4BB0' },     // blue
  COMPLETED: { bg: '#E3F3E6', fg: '#2E7D43' },  // green
  PAID: { bg: '#E3F3E6', fg: '#2E7D43' },       // green
  CANCELED: { bg: '#EEEEEE', fg: '#777' },      // gray
  VOID: { bg: '#EEEEEE', fg: '#777' },          // gray
  EXPIRED: { bg: '#EEEEEE', fg: '#777' },       // gray
  REFUND: { bg: '#FBEBDD', fg: '#B5651D' },     // orange
  PARTIAL_REFUND: { bg: '#FBEBDD', fg: '#B5651D' }, // orange
  UNPAID: { bg: '#FBF3D6', fg: '#9A7B1A' },     // yellow
  RESERVED: { bg: '#FBF3D6', fg: '#9A7B1A' },   // yellow
}
const INCOMPLETE_COLOR = { bg: '#EEEEEE', fg: '#999' } // muted gray
const DEFAULT_STATUS_COLOR = { bg: '#EEEEEE', fg: '#777' }

// Abandoned-cart heuristic: no money on the order AND no customer attached.
// These never completed checkout, so we display "Incomplete" instead of the raw
// FM status (the underlying FM status is left untouched).
function isIncomplete(o: Order) {
  const value = (o.total ?? 0) + (o.transactionsTotal ?? 0)
  return value === 0 && customerName(o) === '—'
}

// Read-only status pill (replaces the old editable dropdown). Shows "Incomplete"
// for abandoned carts; otherwise the friendly label in a status-colored pill.
function StatusPill({ order }: { order: Order }) {
  const incomplete = isIncomplete(order)
  const label = incomplete ? 'Incomplete' : statusLabel(order.orderStatus)
  const c = incomplete ? INCOMPLETE_COLOR : (STATUS_COLORS[order.orderStatus] || DEFAULT_STATUS_COLOR)
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 12,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
      color: c.fg, background: c.bg,
    }}
      title={incomplete ? 'Abandoned cart — never completed checkout' : undefined}>
      {label}
    </span>
  )
}

// Time options for the date/time edit dropdown: 15-minute increments across the
// day, as "HH:MM" values. The current order time is injected if off-grid so the
// dropdown always shows the existing value.
function buildTimeOptions(current?: string): string[] {
  const opts: string[] = []
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }
  const cur = current?.slice(0, 5)
  if (cur && !opts.includes(cur)) {
    opts.push(cur)
    opts.sort()
  }
  return opts
}

// 3P / 1P attribution pill. "DISCO" → 3P (Disco Blue); everything else —
// "FAMILYMEAL", unknown, or absent — → 1P (gray), since direct/unknown orders
// are treated as first-party. Always renders one pill. Small + subtle, no emoji.
function SourcePill({ source }: { source?: string }) {
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

// TYPE column — stacked badge chips matching the Slack notification format:
//   PICKUP → (P) · DELIVERY self → (D) · DELIVERY third-party → (3D)
//   Direct Entry (sourceoforder === 'FAMILYMEAL') adds (DE), e.g. (P)(DE).
function typeBadgeLabels(o: Order): string[] {
  const labels: string[] = []
  const t = (o.orderType || '').toUpperCase()
  if (t === 'DELIVERY') {
    const thirdParty = o.thirdPartyDelivery === true
      || (o.deliveryType || '').toUpperCase().includes('THIRD')
      || !!(o.nashDeliveryPickupEta || o.nashDeliveryDropoffEta)
    labels.push(thirdParty ? '3D' : 'D')
  } else if (t === 'PICKUP') {
    labels.push('P')
  } else if (t) {
    labels.push(t) // unknown order type — show raw value rather than nothing
  }
  if ((o.sourceoforder || '').toUpperCase() === 'FAMILYMEAL') labels.push('DE')
  return labels
}

function TypeBadges({ order }: { order: Order }) {
  const labels = typeBadgeLabels(order)
  if (!labels.length) return <span style={{ color: '#bbb' }}>—</span>
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {labels.map(l => (
        <span key={l} style={{
          display: 'inline-flex', alignItems: 'center', background: DARK, color: '#fff',
          fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, lineHeight: 1.4,
          fontFamily: F,
        }}>({l})</span>
      ))}
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

// "Update Order Date & Time" modal — mirrors FM's date/time edit popup.
// Date input + time dropdown pre-filled with the order's current values, the
// FM operating-hours warning, and a Submit that PUTs to the admin date-time
// proxy. Reuses the restaurant portal's body shape ({ orderDate, orderTime }).
function DateTimeModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const [orderDate, setOrderDate] = useState(order.orderDate || '')
  const [orderTime, setOrderTime] = useState(order.orderTime?.slice(0, 5) || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const timeOptions = buildTimeOptions(order.orderTime)

  async function submit() {
    setSaving(true)
    setError('')
    const res = await fetch(`/api/admin/orders/${order.orderReference}/date-time?restaurantReference=${order.restaurantReference}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderDate, orderTime: orderTime + ':00' }),
    })
    setSaving(false)
    if (res.ok) { onSaved(); onClose() }
    else setError('Could not update. Check the time falls within the restaurant’s hours.')
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '26px 30px', maxWidth: 420, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 17, fontWeight: 700, color: DARK }}>Update Order Date &amp; Time</h3>
        <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.5, color: '#D32F2F' }}>
          You are about to change your order&apos;s date and time. Please ensure that your new
          selection falls within the restaurant&apos;s operating hours and that the menu items in
          your order are available for delivery at the chosen time.
        </p>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Date</label>
          <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none', color: DARK, boxSizing: 'border-box' }} />
        </div>
        <div style={{ marginBottom: 22 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Time</label>
          <select value={orderTime} onChange={e => setOrderTime(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none', color: DARK, background: '#fff', boxSizing: 'border-box' }}>
            {timeOptions.map(t => <option key={t} value={t}>{fmtTime(t)}</option>)}
          </select>
        </div>
        {error && <div style={{ fontSize: 12, color: '#D32F2F', marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>Cancel</button>
          <button onClick={submit} disabled={saving || !orderDate || !orderTime}
            style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer', fontFamily: F, opacity: saving || !orderDate || !orderTime ? 0.6 : 1 }}>
            {saving ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  )
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
  const [editing, setEditing] = useState<Order | null>(null)

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
                <td style={cell}>{o.orderNumber ? `#${o.orderNumber}` : '—'}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>
                  {fmtCurrency(o.total ?? o.transactionsTotal ?? 0)}
                  <InvoicePill paymentMethod={o.paymentMethod} />
                </td>
                <td style={cell}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {fmtDate(o.orderDate)} {fmtTime(o.orderTime)}
                    <button onClick={() => setEditing(o)} title="Update order date &amp; time"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.6 }}>
                      ✏️
                    </button>
                  </span>
                </td>
                <td style={cell}><TypeBadges order={o} /></td>
                <td style={cell}><SourcePill source={o.sourceoforder} /></td>
                <td style={cell}><StatusPill order={o} /></td>
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

      {editing && <DateTimeModal order={editing} onClose={() => setEditing(null)} onSaved={load} />}
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
