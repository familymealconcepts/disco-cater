'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { getOrderSourceBadge } from '../../../../../lib/order-utils'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'
const PAGE_BG = '#F7F8FC'

// Pull the FULL order set up front (all pages, capped) so filters/sort/search run
// client-side across everything, not just one server page. Mirrors the Customers
// page pattern.
const FETCH_SIZE = 500
const MAX_PAGES = 50

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
  // True for Disco-native orders surfaced from Neon (not present in FM's list).
  native?: boolean
  // Third-party-delivery signals. FM doesn't always type these on the list
  // shape, so they're optional; we also fall back to the Nash courier ETAs
  // (nashDelivery*Eta) which only exist on third-party (dispatched) deliveries.
  deliveryType?: string
  thirdPartyDelivery?: boolean
  // Tax-exempt flag. FM's checkout-preview model uses `taxExempt`; the admin
  // list may not always include it (badge simply won't render if absent). We
  // also accept `isTaxExempt` as a defensive variant.
  taxExempt?: boolean
  isTaxExempt?: boolean
  // FM's admin userOrders (UserOrderResponseDto) names the ORDER's own reference
  // `reference` — NOT `orderReference`. Captured here so we can normalize it into
  // orderReference on load (see withOrderRef).
  reference?: string
}

// FM returns the order reference under `reference`; every consumer here (the Edit
// link, transfer, promo lookup, and the row React key) reads `orderReference`.
// Without this, orderReference is undefined → the Edit link becomes
// `/admin/manage-orders/undefined/edit` → details 404 "Order not found".
function withOrderRef(o: Order): Order {
  return { ...o, orderReference: o.orderReference ?? o.reference ?? '' }
}

// ── Client-side filter + sort (FIX: operate on already-loaded orders) ─────────
type SortKey = 'placed' | 'restaurant' | 'customer' | 'orderNumber' | 'total' | 'orderTime' | 'type' | 'source' | 'status'
type TypeFilter = 'all' | 'pickup' | 'delivery' | 'direct'
type StatusFilter = 'all' | 'incomplete' | 'due' | 'completed' | 'expired'
type SourceFilter = 'all' | '1p' | '3p'

const isDirectEntry = (o: Order) => (o.sourceoforder || '').toUpperCase() === 'FAMILYMEAL'
const isTaxExemptOrder = (o: Order) => o.taxExempt === true || o.isTaxExempt === true

function matchesType(o: Order, f: TypeFilter): boolean {
  if (f === 'all') return true
  const t = (o.orderType || '').toUpperCase()
  if (f === 'pickup') return t === 'PICKUP'
  if (f === 'delivery') return t === 'DELIVERY'
  if (f === 'direct') return isDirectEntry(o)
  return true
}
function matchesStatusFilter(o: Order, f: StatusFilter): boolean {
  if (f === 'all') return true
  const inc = isIncomplete(o)
  if (f === 'incomplete') return inc
  if (inc) return false // 'Incomplete' overrides the raw status in the UI
  const s = (o.orderStatus || '').toUpperCase()
  if (f === 'due') return s === 'DUE'
  if (f === 'completed') return s === 'COMPLETED'
  if (f === 'expired') return s === 'EXPIRED'
  return true
}
function matchesSource(o: Order, f: SourceFilter): boolean {
  if (f === 'all') return true
  const is3P = o.sourceoforder === 'DISCO'
  return f === '3p' ? is3P : !is3P
}
// Search matches BOTH customer name and order number (strips a leading #).
function matchesSearch(o: Order, q: string): boolean {
  if (!q) return true
  const term = q.toLowerCase().replace(/^#/, '').trim()
  if (!term) return true
  return customerName(o).toLowerCase().includes(term) || String(o.orderNumber ?? '').includes(term)
}
function orderSortValue(o: Order, key: SortKey): string | number {
  switch (key) {
    case 'placed': return Date.parse(o.createdDate) || 0
    case 'restaurant': return (o.restaurantName || '').toLowerCase()
    case 'customer': return customerName(o).toLowerCase()
    case 'orderNumber': return o.orderNumber ?? 0
    case 'total': return o.total ?? o.transactionsTotal ?? 0
    case 'orderTime': return Date.parse(`${o.orderDate}T${o.orderTime || '00:00:00'}`) || Date.parse(o.orderDate || '') || 0
    case 'type': return typeBadgeLabels(o).join('')
    case 'source': return o.sourceoforder === 'DISCO' ? '3P' : '1P'
    case 'status': return isIncomplete(o) ? 'Incomplete' : statusLabel(o.orderStatus)
  }
}

// Sortable column header with an ↑/↓ indicator on the active column.
function SortTh({ label, k, sort, onSort, align }: {
  label: string; k: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null
  onSort: (k: SortKey) => void
  align?: 'right'
}) {
  const active = sort?.key === k
  const arrow = active ? (sort!.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th onClick={() => onSort(k)} title="Click to sort"
      style={{ ...colHead, textAlign: align || 'left', cursor: 'pointer', userSelect: 'none', color: active ? DARK : '#888' }}>
      {label}{arrow}
    </th>
  )
}

// "TAX EXEMPT" pill shown next to the Total when the order is tax-exempt.
function TaxExemptBadge({ order }: { order: Order }) {
  if (!isTaxExemptOrder(order)) return null
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 10,
      fontSize: 10, fontWeight: 700, letterSpacing: '0.02em', verticalAlign: 'middle',
      color: '#92400E', background: '#FEF3C7', whiteSpace: 'nowrap',
    }}
      title="Tax exempt order">
      TAX EXEMPT
    </span>
  )
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
  // Stack vertically (delivery badge on top, (DE) below) so wide combos like
  // (3D)(DE) don't overflow the cell. Both chips left-aligned.
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
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
// Date helpers for the default range (YYYY-MM-DD, matching <input type="date">).
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d
}
// firstName + lastName, falling back to email, then an em dash.
function customerName(o: Order) {
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim()
  return name || o.email || '—'
}
function fmtDate(d?: string) {
  if (!d) return ''
  // orderDate is a bare "YYYY-MM-DD" (no offset) — parses as UTC midnight per
  // spec, so routing it through `new Date(d)` + local toLocaleDateString
  // silently shows the day before the one actually stored, in any
  // UTC-negative timezone. Read the digits directly and format in UTC instead.
  // Same fix pattern as lib/order-edit.ts's fmtDateHuman/ae8bdf2.
  // createdDate is a full datetime string (has a time component) — leave it on
  // the original `new Date(d)` path unchanged; it isn't a bare date and isn't
  // affected by this bug.
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (bareDate) {
    return new Date(Date.UTC(+bareDate[1], +bareDate[2] - 1, +bareDate[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  }
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

// Right-anchored order details panel — opens when a SUPER_ADMIN clicks an order
// row. Shows the order summary and (SUPER_ADMIN only) a "Transfer Order" action.
function OrderDetailsPanel({ order, isSuperAdmin, onClose, onTransferred }: { order: Order; isSuperAdmin: boolean; onClose: () => void; onTransferred: () => void }) {
  const [transferOpen, setTransferOpen] = useState(false)
  const [refunding, setRefunding] = useState(false)

  // Native orders only: a REAL Stripe refund via /api/admin/orders/{ref}/refund
  // (FM orders are refunded on FM's side, unchanged). Minimal prompt-based flow —
  // this is a rare, super-admin financial action.
  async function doRefund() {
    const max = order.total ?? order.transactionsTotal ?? 0
    const input = window.prompt(`Refund amount for order ${order.orderNumber ? `#${order.orderNumber}` : ''} (max $${max.toFixed(2)}):`, max.toFixed(2))
    if (input == null) return
    const amount = Number(input)
    if (!(amount > 0)) { window.alert('Enter a valid amount greater than 0.'); return }
    if (!window.confirm(`Issue a REAL $${amount.toFixed(2)} refund to the customer? This moves money via Stripe and can't be undone here.`)) return
    setRefunding(true)
    try {
      const res = await fetch(`/api/admin/orders/${order.orderReference}/refund`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) { window.alert(d?.warning || `Refunded $${amount.toFixed(2)}.`); onTransferred(); onClose() }
      else window.alert(d?.error || 'Refund failed.')
    } catch { window.alert('Refund failed.') }
    finally { setRefunding(false) }
  }
  const detailRow = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid #f2f2f5' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888' }}>{label}</span>
      <span style={{ fontSize: 13, color: DARK, textAlign: 'right' }}>{value}</span>
    </div>
  )
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 290 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 440, maxWidth: '92vw', background: '#fff', zIndex: 300, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', fontFamily: F }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>Order {order.orderNumber ? `#${order.orderNumber}` : 'Details'}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#888', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 24px' }}>
          {detailRow('Restaurant', order.restaurantName || '—')}
          {detailRow('Customer', `${order.firstName || ''} ${order.lastName || ''}`.trim() || '—')}
          {order.email && detailRow('Email', order.email)}
          {detailRow('Order date', `${fmtDate(order.orderDate)} ${fmtTime(order.orderTime)}`)}
          {detailRow('Type', order.orderType || '—')}
          {detailRow('Status', order.orderStatus || '—')}
          {detailRow('Total', fmtCurrency(order.total ?? order.transactionsTotal ?? 0))}
        </div>
        {isSuperAdmin && (
          <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={() => setTransferOpen(true)}
              style={{ width: '100%', padding: '11px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
              Transfer Order
            </button>
            {order.native && order.orderStatus !== 'REFUNDED' && (
              <button onClick={doRefund} disabled={refunding}
                style={{ width: '100%', padding: '11px 18px', border: '1px solid #E7B4B6', borderRadius: 8, background: '#fff', color: '#C42A30', fontSize: 14, fontWeight: 700, cursor: refunding ? 'wait' : 'pointer', opacity: refunding ? 0.7 : 1, fontFamily: F }}>
                {refunding ? 'Refunding…' : 'Refund (Stripe)'}
              </button>
            )}
          </div>
        )}
      </div>
      {transferOpen && (
        <TransferOrderModal
          order={order}
          onClose={() => setTransferOpen(false)}
          onSaved={() => { setTransferOpen(false); onTransferred(); onClose() }}
        />
      )}
    </>
  )
}

// "Transfer Order to Another Location" modal — searchable picker over
// disco_restaurant_cache, then POST to the SUPER_ADMIN transfer route.
function TransferOrderModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const [restaurants, setRestaurants] = useState<{ reference: string; name: string }[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [query, setQuery] = useState('')
  const [selectedRef, setSelectedRef] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/restaurant-cache/list')
      .then(r => (r.ok ? r.json() : { restaurants: [] }))
      .then(d => { if (!cancelled) { setRestaurants(d.restaurants || []); setLoadingList(false) } })
      .catch(() => { if (!cancelled) setLoadingList(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = restaurants
    .filter(r => r.reference !== order.restaurantReference) // can't transfer to itself
    .filter(r => r.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 100)

  async function submit() {
    if (!selectedRef) return
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/admin/orders/${order.orderReference}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRestaurantReference: selectedRef }),
      })
      if (res.ok) { onSaved() }
      else { const d = await res.json().catch(() => ({})); setError(d?.error || 'Transfer failed') }
    } catch {
      setError('Transfer failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', maxWidth: 460, width: '92%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: DARK }}>
          Transfer Order {order.orderNumber ? `#${order.orderNumber}` : ''} to Another Location
        </h3>
        <input
          type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search restaurants by name…"
          style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box', marginBottom: 10 }}
        />
        <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #eee', borderRadius: 8, marginBottom: 14 }}>
          {loadingList ? (
            <div style={{ padding: '14px', fontSize: 13, color: '#999' }}>Loading restaurants…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '14px', fontSize: 13, color: '#999' }}>No restaurants found.</div>
          ) : (
            filtered.map(r => {
              const active = r.reference === selectedRef
              return (
                <button key={r.reference} onClick={() => setSelectedRef(r.reference)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid #f2f2f5', background: active ? '#EEF0FF' : '#fff', color: active ? BLUE : DARK, fontSize: 13, fontWeight: active ? 700 : 400, cursor: 'pointer', fontFamily: F }}>
                  {r.name}
                </button>
              )
            })
          )}
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.5, color: '#666' }}>
          The customer and both restaurants will be notified by email.
        </p>
        {error && <div style={{ fontSize: 12, color: '#D32F2F', marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, color: DARK }}>Cancel</button>
          <button onClick={submit} disabled={!selectedRef || saving}
            style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: !selectedRef || saving ? 'default' : 'pointer', fontFamily: F, opacity: !selectedRef || saving ? 0.6 : 1 }}>
            {saving ? 'Transferring…' : 'Transfer Order'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminOrdersContent() {
  const [orders, setOrders] = useState<Order[]>([])
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [searchInput, setSearchInput] = useState('')
  // FM filters this range by catering/order date, not placed date — so a recently
  // placed order with a far-future (or past) catering date falls outside a narrow
  // window. Default to ±60 days so recently placed orders show regardless of which
  // date FM filters on. (YYYY-MM-DD to match the date inputs; the API converts to
  // FM's DD.MM.YYYY. daysAgo(-60) = 60 days from now.)
  // Default to the last 10 days (was 60) — the FM dataset is large and the old
  // window made the initial load slow. The proxy converts ISO → DD.MM.YYYY.
  const [fromDate, setFromDate] = useState(() => isoDate(daysAgo(10)))
  const [toDate, setToDate] = useState(() => isoDate(daysAgo(-60)))
  const [loading, setLoading] = useState(true)
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()

  // Edit-success banner — the admin edit page redirects back here with
  // ?editSuccess=true&orderNumber=XXXXX&editOutcome=success|invoiced. Capture it
  // into a dismissible banner, then strip the params from the URL so a refresh
  // doesn't re-show it (mirrors the restaurant orders list).
  const [editSuccessBanner, setEditSuccessBanner] = useState<string | null>(null)
  const [editOutcome, setEditOutcome] = useState<string>('success')
  useEffect(() => {
    if (searchParams.get('editSuccess') !== 'true') return
    setEditSuccessBanner(searchParams.get('orderNumber') || '')
    setEditOutcome(searchParams.get('editOutcome') || 'success')
    const p = new URLSearchParams(searchParams.toString())
    p.delete('editSuccess')
    p.delete('orderNumber')
    p.delete('editOutcome')
    const qs = p.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Order details panel (opens on row click for SUPER_ADMIN) + role flag.
  const [selected, setSelected] = useState<Order | null>(null)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('admin_user')
      setIsSuperAdmin(raw ? JSON.parse(raw).role === 'SUPER_ADMIN' : false)
    } catch {}
  }, [])
  // Disco promo per order (orderRef → promo), from promo_code_uses. Batch-looked
  // up after orders load. Display-only; FM coupons are not included here.
  const [promos, setPromos] = useState<Record<string, { code: string; discountApplied: number; refundStatus: string }>>({})

  // Client-side filters + sort, applied across the FULL fetched dataset (see
  // load below). The date range stays a server filter — it scopes which orders
  // are fetched up front; pagination is now client-side over the filtered set.
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  // Default to placed,desc (newest-created first). This is the original fix for the
  // native-pinning bug: the API prepends all Disco-native rows onto page 0, but the
  // client ALWAYS re-sorts the full merged native+FM set below, so native orders are
  // never special-cased/pinned — they're just ordered by created date like the rest.
  // Test 50's native orders sitting at the top is expected here: they were placed
  // most recently, and placed,desc = newest first. The "Placed" column shows its sort
  // arrow. (The visible builder falls back to this if sort is ever cleared to null.)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>({ key: 'placed', dir: 'desc' })

  // Fetch ALL pages (capped at MAX_PAGES) so filters/sort run over everything.
  const load = useCallback(async () => {
    setLoading(true)
    const url = (p: number) => {
      const params = new URLSearchParams()
      if (p > 0) params.set('page', String(p))
      params.set('size', String(FETCH_SIZE))
      if (fromDate) params.set('fromDate', fromDate)
      if (toDate) params.set('toDate', toDate)
      params.append('sort', 'createdDate,desc')
      return `/api/admin/orders?${params}`
    }
    try {
      const first = await fetch(url(0)).then(r => (r.ok ? r.json() : null))
      if (!first) {
        console.error('[admin/orders] first page fetch failed', { fromDate, toDate })
        setOrders([]); setLoading(false); return
      }
      let all: Order[] = (first.content || []).map(withOrderRef)
      // FM's userOrders may omit totalPages (or name it total_pages); if so,
      // `?? 1` would silently stop at page 0 and drop the rest. Fall back to
      // computing pages from totalElements / FETCH_SIZE.
      const totalElements = Number(first.totalElements ?? first.total_elements ?? 0)
      const reportedPages = first.totalPages ?? first.total_pages
      const computedPages = totalElements > 0
        ? Math.ceil(totalElements / FETCH_SIZE)
        : (all.length > 0 ? 1 : 0)
      const totalPages = Math.min(Number(reportedPages ?? computedPages) || (all.length > 0 ? 1 : 0), MAX_PAGES)
      console.log('[admin/orders] page 0 →', all.length, 'orders', { totalElements, reportedPages, computedPages, totalPages })
      if (totalPages > 1) {
        const rest = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetch(url(i + 1)).then(r => (r.ok ? r.json() : null))),
        )
        rest.forEach((pg, i) => {
          const c = pg?.content?.length || 0
          console.log(`[admin/orders] page ${i + 1} → ${c} orders`)
          if (pg?.content) all = all.concat((pg.content as Order[]).map(withOrderRef))
        })
      }
      console.log(`[admin/orders] loaded ${all.length} orders across ${totalPages} page(s)`, { fromDate, toDate })
      if (all.length === 0) {
        console.error('[admin/orders] FM returned 0 orders', { fromDate, toDate, totalElements })
      }
      setOrders(all)
    } catch (err) {
      console.error('[admin/orders] orders fetch error', err)
      setOrders([])
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate])

  useEffect(() => { load() }, [load])

  // Batch-lookup Disco promos for the loaded orders (one request, capped at 500).
  useEffect(() => {
    const refs = orders.map(o => o.orderReference).filter(Boolean)
    if (refs.length === 0) { setPromos({}); return }
    let cancelled = false
    fetch(`/api/promo/order-promo?orderRefs=${encodeURIComponent(refs.slice(0, 500).join(','))}`)
      .then(r => r.ok ? r.json() : {})
      .then(d => { if (!cancelled) setPromos(d || {}) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [orders])

  // Reset to the first client page whenever the filtered/sorted result set changes.
  useEffect(() => { setPage(0) }, [searchInput, typeFilter, statusFilter, sourceFilter, sort, pageSize])

  function toggleSort(key: SortKey) {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null // third click clears
    })
  }

  const filtersActive = !!searchInput.trim() || typeFilter !== 'all' || statusFilter !== 'all' || sourceFilter !== 'all'

  function clearFilters() {
    setSearchInput(''); setTypeFilter('all'); setStatusFilter('all'); setSourceFilter('all'); setSort(null)
  }

  // Filter then sort the loaded page client-side.
  const visible = (() => {
    const filtered = orders.filter(o =>
      matchesType(o, typeFilter) &&
      matchesStatusFilter(o, statusFilter) &&
      matchesSource(o, sourceFilter) &&
      matchesSearch(o, searchInput),
    )
    // Default (no column chosen): newest-created first (placed,desc) across the FULL
    // merged set — native + FM-backed together. The API prepends all Disco-native
    // orders onto page 0, but this ALWAYS re-sorts the full set, so native orders are
    // never pinned above FM orders — they interleave purely by placed date.
    const active = sort ?? { key: 'placed' as SortKey, dir: 'desc' as const }
    const mul = active.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const va = orderSortValue(a, active.key)
      const vb = orderSortValue(b, active.key)
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul
      return String(va).localeCompare(String(vb)) * mul
    })
  })()

  // Client-side pagination over the filtered/sorted full set.
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  const pageRows = visible.slice(page * pageSize, (page + 1) * pageSize)

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, background: PAGE_BG, minHeight: '100vh' }}>
      {editSuccessBanner !== null && (() => {
        const tag = editSuccessBanner ? `Order #${editSuccessBanner}` : 'Order'
        const message = editOutcome === 'invoiced'
          ? `${tag} has been updated. The customer has been sent an invoice for the difference.`
          : `${tag} has been updated successfully.`
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', marginBottom: 16, background: '#ECFDF3', border: '1px solid #ABEFC6', borderRadius: 8 }}>
            <span style={{ fontSize: 13, color: '#067647', fontWeight: 600 }}>{message}</span>
            <button onClick={() => setEditSuccessBanner(null)} aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: '#067647', fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
          </div>
        )
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Orders</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setPage(0) }} style={inputSt} />
          <span style={{ color: '#888' }}>→</span>
          <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setPage(0) }} style={inputSt} />
          <input type="text" placeholder="Search name or order #…" value={searchInput} onChange={e => setSearchInput(e.target.value)} style={{ ...inputSt, width: 220 }} />
        </div>
      </div>

      <div style={{ fontSize: 12, color: '#999', marginBottom: 14 }}>
        Showing active order window — adjust range to see more.
      </div>

      {/* Filter bar — client-side over the loaded page */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={chipLabel}>Type</span>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as TypeFilter)} style={selectSt} aria-label="Type filter">
          <option value="all">All</option>
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
          <option value="direct">Direct Entry</option>
        </select>
        <span style={chipLabel}>Status</span>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)} style={selectSt} aria-label="Status filter">
          <option value="all">All</option>
          <option value="incomplete">Incomplete</option>
          <option value="due">Due</option>
          <option value="completed">Completed</option>
          <option value="expired">Expired</option>
        </select>
        <span style={chipLabel}>Source</span>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value as SourceFilter)} style={selectSt} aria-label="Source filter">
          <option value="all">All</option>
          <option value="1p">1P</option>
          <option value="3p">3P</option>
        </select>
        {filtersActive && (
          <button onClick={clearFilters} style={{ background: 'none', border: 'none', color: BLUE, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: F, textDecoration: 'underline', padding: 0 }}>
            Clear filters
          </button>
        )}
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
          <thead>
            <tr>
              <SortTh label="Placed" k="placed" sort={sort} onSort={toggleSort} />
              <SortTh label="Restaurant" k="restaurant" sort={sort} onSort={toggleSort} />
              <SortTh label="Customer" k="customer" sort={sort} onSort={toggleSort} />
              <SortTh label="Order #" k="orderNumber" sort={sort} onSort={toggleSort} />
              <SortTh label="Total" k="total" sort={sort} onSort={toggleSort} align="right" />
              <SortTh label="Order Time" k="orderTime" sort={sort} onSort={toggleSort} />
              <SortTh label="Type" k="type" sort={sort} onSort={toggleSort} />
              <SortTh label="Source" k="source" sort={sort} onSort={toggleSort} />
              <th style={colHead}>Promo</th>
              <SortTh label="Status" k="status" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={10} style={{ ...cell, textAlign: 'center', color: '#999' }}>Loading orders…</td></tr>}
            {!loading && !visible.length && <tr><td colSpan={10} style={{ ...cell, textAlign: 'center', color: '#999' }}>{filtersActive ? 'No orders match these filters.' : 'No orders.'}</td></tr>}
            {!loading && pageRows.map(o => (
              <tr key={o.orderReference}
                onClick={isSuperAdmin ? () => setSelected(o) : undefined}
                style={isSuperAdmin ? { cursor: 'pointer' } : undefined}>
                <td style={{ ...cell, color: '#666' }}>{fmtDate(o.createdDate)}</td>
                <td style={cell}>{o.restaurantName}</td>
                <td style={cell}>{customerName(o)}</td>
                <td style={cell}>{o.orderNumber ? `#${o.orderNumber}` : '—'}</td>
                <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>
                  {fmtCurrency(o.total ?? o.transactionsTotal ?? 0)}
                  <InvoicePill paymentMethod={o.paymentMethod} />
                  <TaxExemptBadge order={o} />
                </td>
                <td style={cell}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {fmtDate(o.orderDate)} {fmtTime(o.orderTime)}
                    <button onClick={(e) => { e.stopPropagation(); router.push(`/admin/manage-orders/${o.orderReference}/edit`) }} title="Edit order (items, quantities, date & time)"
                      style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, opacity: 0.6 }}>
                      ✏️
                    </button>
                  </span>
                </td>
                <td style={cell}><TypeBadges order={o} /></td>
                <td style={cell}>{getOrderSourceBadge(o.sourceoforder || '')}{o.native ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6B6EF9', background: '#EEF0FF', borderRadius: 4, padding: '1px 5px' }}>Native</span> : null}</td>
                <td style={cell}>
                  {promos[o.orderReference] ? (() => {
                    const p = promos[o.orderReference]
                    // Three states: completed (gradient), pending (grey, in-flight),
                    // failed (amber warning).
                    const failed = p.refundStatus === 'failed'
                    const pending = p.refundStatus === 'pending'
                    const bg = failed ? '#EFB84A' : pending ? '#999' : 'linear-gradient(90deg, #6B6EF9, #C044C8, #F0468A)'
                    const prefix = failed ? '⚠ ' : pending ? '⏳ ' : ''
                    const title = failed
                      ? 'Disco promo — credit not yet applied (contact support)'
                      : pending
                        ? 'Disco promo — credit being processed'
                        : 'Disco promo (credited to the customer via Stripe)'
                    return (
                      <span style={{ display: 'inline-block', color: '#fff', borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', background: bg }}
                        title={title}>
                        {prefix}{p.code} −{fmtCurrency(p.discountApplied)}
                      </span>
                    )
                  })() : null}
                </td>
                <td style={cell}><StatusPill order={o} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <div style={{ fontSize: 12, color: '#666' }}>
          {loading ? 'Loading…' : `${filtersActive ? `${visible.length} of ${orders.length}` : visible.length} order${visible.length === 1 ? '' : 's'}`}
        </div>
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

      {selected && (
        <OrderDetailsPanel
          order={selected}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setSelected(null)}
          onTransferred={load}
        />
      )}
    </div>
  )
}

const colHead: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', padding: '12px 14px', textAlign: 'left', background: '#F7F8FC', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' }
const cell: React.CSSProperties = { padding: '14px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0', verticalAlign: 'middle' }
const inputSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const selectSt: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }
const chipLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#888' }
const smallSelect: React.CSSProperties = { border: '1.5px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, color: DARK, background: '#fff' }
const pageBtn: React.CSSProperties = { background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontFamily: F, color: DARK }
// Suppress unused-variable warning if BLUE is unreferenced after edits.
void BLUE

// Suspense wrapper — required because AdminOrdersContent reads useSearchParams()
// (for the edit-success banner), which Next needs inside a Suspense boundary.
export default function AdminOrdersPage() {
  return (
    <Suspense>
      <AdminOrdersContent />
    </Suspense>
  )
}
