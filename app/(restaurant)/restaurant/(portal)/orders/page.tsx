'use client'
import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#6B6EF9'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Order {
  orderReference: string
  orderNumber: number
  firstName: string
  lastName: string
  orderDate: string
  orderTime: string
  orderCreatedDate: string
  restaurantTimezone: string
  orderType: string
  deliveryType: string
  transactionsTotal: number
  orderStatus: string
  orderSeenByAdmin: boolean
  orderStatusesToChange: string[]
  nashDeliveryStatus?: string
  nashDeliveryPickupEta?: string
  nashDeliveryDropoffEta?: string
  nashDeliveryPublicTrackingUrl?: string
  maxAllowedRefundAmount?: number
  note?: string
}

interface SalesStatItem {
  addOnName?: string
  mealPackageName?: string
  count: number
  price: number
  total: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = ['DUE', 'UNPAID', 'PAID']
const HISTORY_STATUSES = ['COMPLETED', 'REOPEN', 'CANCELED', 'EXPIRED', 'RESERVED', 'VOID', 'REFUND', 'PARTIAL_REFUND']
const COUNTS_STATUSES = ['COMPLETED', 'DUE']
const TERMINAL = new Set(['EXPIRED', 'REOPEN', 'REFUND', 'PARTIAL_REFUND', 'CANCELED', 'VOID'])

const STATUS_LABEL: Record<string, string> = {
  DUE: 'Due', COMPLETED: 'Completed', REOPEN: 'Reopened', REFUND: 'Refunded',
  PARTIAL_REFUND: 'Partial refunded', CANCELED: 'Canceled', EXPIRED: 'Expired',
  RESERVED: 'Reserved', VOID: 'Voided', PAID: 'Paid', UNPAID: 'Unpaid',
}

const DELIVERY_LABEL: Record<string, string> = {
  OWN_DELIVERY: 'Self-Delivery', NASH_DELIVERY: 'Third-Party (Nash)',
  DOOR_DASH_DELIVERY: 'DoorDash Delivery', DLIVRD_DELIVERY: 'Dlivrd Delivery',
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-')
  return `${mo}/${day}/${y}`
}

function statusColor(status: string, orderDate: string, orderTime: string) {
  if (!orderDate || !orderTime) return undefined
  const dt = new Date(`${orderDate}T${orderTime}`)
  const now = new Date()
  const diffMs = dt.getTime() - now.getTime()
  if (diffMs >= 0 && diffMs <= 3600000) return '#77AE70'
  if (diffMs < 0) return '#E76F51'
  return undefined
}

// ─── Components ──────────────────────────────────────────────────────────────

function ConfirmDialog({ message, onConfirm, onCancel }: { message: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <p style={{ fontSize: 14, color: DARK, margin: '0 0 20px', lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={onConfirm} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Confirm</button>
        </div>
      </div>
    </div>
  )
}

function NoteModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(order.note || '')
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    await fetch(`/api/restaurant/orders/${order.orderReference}/note`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
    })
    setSaving(false)
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 420, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>Add Note</h3>
        <textarea
          value={note} onChange={e => setNote(e.target.value)} required
          style={{ width: '100%', minHeight: 100, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: F, resize: 'vertical', outline: 'none' }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !note.trim()} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  )
}

function RefundModal({ order, isVoid, onClose, onSaved }: { order: Order; isVoid?: boolean; onClose: () => void; onSaved: () => void }) {
  const maxAmt = isVoid ? order.transactionsTotal : (order.maxAllowedRefundAmount || order.transactionsTotal)
  const [amount, setAmount] = useState(String(maxAmt || ''))
  const [useFullAmt, setUseFullAmt] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (useFullAmt) setAmount(String(maxAmt || '')) }, [useFullAmt, maxAmt])
  async function save() {
    setSaving(true)
    await fetch(`/api/restaurant/orders/${order.orderReference}/refund`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: parseFloat(amount) }),
    })
    setSaving(false)
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>{isVoid ? 'Void Order' : 'Refund Order'}</h3>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Amount</label>
          <input
            type="number" value={amount} onChange={e => setAmount(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', color: '#555', marginBottom: 16 }}>
          <input type="checkbox" checked={useFullAmt} onChange={e => setUseFullAmt(e.target.checked)} />
          Use full amount ({fmt(maxAmt)})
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !amount} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#E76F51', color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>
            {isVoid ? 'Void' : 'Refund'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ReopenModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const [orderDate, setOrderDate] = useState(order.orderDate || '')
  const [orderTime, setOrderTime] = useState(order.orderTime?.slice(0, 5) || '')
  const [saving, setSaving] = useState(false)
  async function save() {
    setSaving(true)
    await fetch(`/api/restaurant/orders/${order.orderReference}/reopen`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderDate, orderTime: orderTime + ':00' }),
    })
    setSaving(false)
    onSaved()
    onClose()
  }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '28px 32px', maxWidth: 380, width: '90%', fontFamily: F }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, color: DARK }}>Reopen Order</h3>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Date</label>
          <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }} />
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Order Time</label>
          <input type="time" value={orderTime} onChange={e => setOrderTime(e.target.value)}
            style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, outline: 'none' }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={save} disabled={saving || !orderDate || !orderTime} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: BLUE, color: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>Reopen</button>
        </div>
      </div>
    </div>
  )
}

function OrderDrawer({ orderRef, onClose, onOrderUpdated }: { orderRef: string; onClose: () => void; onOrderUpdated: () => void }) {
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'refund' | 'void' | 'reopen' | 'note' | null>(null)
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null)

  const loadOrder = useCallback(async () => {
    const res = await fetch(`/api/restaurant/orders/${orderRef}`)
    if (res.ok) setOrder(await res.json())
    setLoading(false)
  }, [orderRef])

  useEffect(() => { loadOrder() }, [loadOrder])

  async function updateStatus(status: string) {
    await fetch(`/api/restaurant/orders/${orderRef}/status?orderStatus=${status}`, { method: 'PUT' })
    onOrderUpdated()
    loadOrder()
  }

  function handleStatusChange(status: string) {
    if (status === 'CANCELED' || status === 'VOID') {
      setConfirm({
        msg: 'Do you want to cancel? Order status will be changed and customer will be notified.',
        action: () => updateStatus(status),
      })
    } else {
      updateStatus(status)
    }
  }

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: '#fff', zIndex: 200, boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', fontFamily: F }}>
      {/* Header */}
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>Order Details</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#888', lineHeight: 1 }}>×</button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {loading && <div style={{ color: '#888', fontSize: 13 }}>Loading…</div>}
        {order && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: DARK, marginBottom: 4 }}>
                #{order.orderNumber} — {order.firstName} {order.lastName}
              </div>
              <div style={{ fontSize: 13, color: '#888' }}>
                {fmtDate(order.orderDate)} at {fmtTime(order.orderTime)} · {DELIVERY_LABEL[order.deliveryType] || order.orderType}
              </div>
            </div>

            <div style={{ background: '#F7F8FC', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#666' }}>Status</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: DARK }}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, color: '#666' }}>Total</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{fmt(order.transactionsTotal)}</span>
              </div>
            </div>

            {order.note && (
              <div style={{ background: '#FFF9E6', border: '1px solid #FFE9A0', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#7A6020' }}>
                <strong>Note:</strong> {order.note}
              </div>
            )}

            {/* Status Change */}
            {!TERMINAL.has(order.orderStatus) && order.orderStatusesToChange?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }}>Change Status</label>
                <select
                  value=""
                  onChange={e => { if (e.target.value) handleStatusChange(e.target.value) }}
                  style={{ width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '9px 12px', fontSize: 13, fontFamily: F, background: '#fff', outline: 'none' }}
                >
                  <option value="">Select new status…</option>
                  {order.orderStatusesToChange.map(s => (
                    <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {order.orderStatus === 'DUE' && (
                <button onClick={() => handleStatusChange('COMPLETED')}
                  style={{ padding: '8px 14px', background: '#22C55E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Complete
                </button>
              )}
              {order.orderStatus === 'COMPLETED' && (
                <>
                  <button onClick={() => setModal('refund')}
                    style={{ padding: '8px 14px', background: '#E76F51', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    Refund
                  </button>
                  <button onClick={() => setModal('reopen')}
                    style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                    Reopen
                  </button>
                </>
              )}
              {!TERMINAL.has(order.orderStatus) && (
                <button onClick={() => setModal('void')}
                  style={{ padding: '8px 14px', background: '#6B7280', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  Void
                </button>
              )}
              <button onClick={() => setModal('note')}
                style={{ padding: '8px 14px', background: '#F59E0B', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Note
              </button>
              <button onClick={() => window.open(`https://api.familymeal.com/public-api/order/${orderRef}/pdf`, '_blank')}
                style={{ padding: '8px 14px', background: '#fff', color: DARK, border: '1px solid #ddd', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Print
              </button>
            </div>
          </>
        )}
      </div>

      {modal === 'refund' && order && <RefundModal order={order} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'void' && order && <RefundModal order={order} isVoid onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'reopen' && order && <ReopenModal order={order} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {modal === 'note' && order && <NoteModal order={order} onClose={() => setModal(null)} onSaved={() => { onOrderUpdated(); loadOrder() }} />}
      {confirm && <ConfirmDialog message={confirm.msg} onConfirm={() => { confirm.action(); setConfirm(null) }} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

// ─── Order Counts Tab ─────────────────────────────────────────────────────────

function OrderCountsTab() {
  const today = new Date().toISOString().split('T')[0]
  const plus6 = new Date(Date.now() + 6 * 86400000).toISOString().split('T')[0]
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(plus6)
  const [data, setData] = useState<{ mealPackages: SalesStatItem[]; addOns: SalesStatItem[] } | null>(null)

  const load = useCallback(async () => {
    if (!fromDate || !toDate) return
    const params = new URLSearchParams({ fromDate, toDate })
    COUNTS_STATUSES.forEach(s => params.append('orderStatuses', s))
    const res = await fetch(`/api/restaurant/orders/sale-stats?${params}`)
    if (res.ok) setData(await res.json())
  }, [fromDate, toDate])

  useEffect(() => { load() }, [load])

  const colHead = { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase' as const, padding: '10px 14px', textAlign: 'left' as const }
  const cell = { padding: '10px 14px', fontSize: 13, color: DARK, borderTop: '1px solid #f0f0f0' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
          style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
        <span style={{ color: '#aaa' }}>–</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
          style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '7px 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
      </div>

      {data && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>Items</h3>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', marginBottom: 24, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#F7F8FC' }}>
                <th style={colHead}>Items</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Count</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Price</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Total ($)</th>
              </tr></thead>
              <tbody>
                {data.mealPackages?.map((item, i) => (
                  <tr key={i}>
                    <td style={cell}>{item.mealPackageName || item.addOnName || '—'}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{item.count}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.price)}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.total)}</td>
                  </tr>
                ))}
                {!data.mealPackages?.length && (
                  <tr><td colSpan={4} style={{ ...cell, color: '#aaa', textAlign: 'center' }}>No data</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h3 style={{ fontSize: 14, fontWeight: 700, color: DARK, margin: '0 0 12px' }}>Modifiers</h3>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: '#F7F8FC' }}>
                <th style={colHead}>Modifier</th>
                <th style={colHead}>Items</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Count</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Price</th>
                <th style={{ ...colHead, textAlign: 'right' }}>Total ($)</th>
              </tr></thead>
              <tbody>
                {data.addOns?.map((item, i) => (
                  <tr key={i}>
                    <td style={cell}>{item.addOnName || '—'}</td>
                    <td style={cell}>{item.mealPackageName || '—'}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{item.count}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.price)}</td>
                    <td style={{ ...cell, textAlign: 'right' }}>{fmt(item.total)}</td>
                  </tr>
                ))}
                {!data.addOns?.length && (
                  <tr><td colSpan={5} style={{ ...cell, color: '#aaa', textAlign: 'center' }}>No data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Main Orders Page ─────────────────────────────────────────────────────────

function OrdersContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const tab = (searchParams.get('tab') || 'active') as 'active' | 'history' | 'counts'
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [size] = useState(25)
  const [search, setSearch] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [sortField, setSortField] = useState('order_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [drawerRef, setDrawerRef] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const statuses = tab === 'active' ? ACTIVE_STATUSES : HISTORY_STATUSES

  function setTab(t: string) {
    const p = new URLSearchParams(searchParams.toString())
    p.set('tab', t)
    router.replace(`${pathname}?${p}`)
    setPage(0)
    setSearch('')
    setFromDate('')
    setToDate('')
  }

  const loadOrders = useCallback(async (resetPage?: boolean) => {
    if (tab === 'counts') return
    setLoading(true)
    const p = new URLSearchParams()
    const currentPage = resetPage ? 0 : page
    p.set('page', String(currentPage))
    p.set('size', String(size))
    statuses.forEach(s => p.append('orderStatuses', s))
    p.append('sort', `${sortField},${sortDir}`)
    if (sortField === 'order_date') p.append('sort', `order_time,${sortDir}`)
    if (sortField === 'first_name') p.append('sort', `last_name,${sortDir}`)
    if (search) p.set('search', search)
    if (fromDate) p.set('fromDate', fromDate)
    if (toDate) p.set('toDate', toDate)
    const res = await fetch(`/api/restaurant/orders?${p}`)
    if (res.ok) {
      const d = await res.json()
      setOrders(d.content || [])
      setTotal(d.totalElements || 0)
    }
    setLoading(false)
  }, [tab, page, size, statuses, sortField, sortDir, search, fromDate, toDate])

  // Load whenever any dependency in loadOrders changes (tab, page, sort, search, dates)
  useEffect(() => {
    loadOrders()
  }, [loadOrders])

  // Polling for active tab
  useEffect(() => {
    if (tab !== 'active') return
    const id = setInterval(() => loadOrders(), 60000)
    return () => clearInterval(id)
  }, [loadOrders, tab])

  async function openOrder(order: Order) {
    if (!order.orderSeenByAdmin) {
      await fetch(`/api/restaurant/orders/${order.orderReference}/seen`, { method: 'PUT' })
      setOrders(prev => prev.map(o => o.orderReference === order.orderReference ? { ...o, orderSeenByAdmin: true } : o))
    }
    setDrawerRef(order.orderReference)
  }

  async function handleMarkAllComplete() {
    setConfirm({
      msg: 'Mark all active orders as complete? This will complete all DUE/PAID orders.',
      action: async () => {
        const params = new URLSearchParams()
        if (fromDate) params.set('fromDate', fromDate)
        if (toDate) params.set('toDate', toDate)
        await fetch(`/api/restaurant/orders/set-completed?${params}`, { method: 'PUT' })
        loadOrders()
      },
    })
  }

  function handleSort(field: string) {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
  }

  const totalPages = Math.ceil(total / size)
  const colHead = (field: string, label: string) => (
    <th
      onClick={() => handleSort(field)}
      style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', background: '#F7F8FC' }}
    >
      {label} {sortField === field ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  )

  return (
    <div style={{ padding: '28px 32px', fontFamily: F }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 20px' }}>Orders</h1>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #e8e8e8', marginBottom: 20 }}>
        {[['active', 'Active'], ['history', 'Order History'], ['counts', 'Order Counts']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              padding: '10px 20px', background: 'none', border: 'none', borderBottom: tab === key ? `2px solid ${BLUE}` : '2px solid transparent',
              color: tab === key ? BLUE : '#888', fontWeight: tab === key ? 700 : 400,
              fontSize: 14, cursor: 'pointer', fontFamily: F, marginBottom: -1,
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'counts' ? (
        <OrderCountsTab />
      ) : (
        <>
          {/* Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <input
              type="text" placeholder="Search orders…" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadOrders(true)}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: F, outline: 'none', minWidth: 200 }}
            />
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, outline: 'none' }} />
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: F, outline: 'none' }} />
            {(search || fromDate || toDate) && (
              <button onClick={() => { setSearch(''); setFromDate(''); setToDate('') }}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: F }}>
                Clear
              </button>
            )}
            <button onClick={() => loadOrders(true)}
              style={{ padding: '8px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
              Search
            </button>
            {tab === 'active' && (
              <button onClick={handleMarkAllComplete}
                style={{ padding: '8px 14px', background: '#22C55E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, marginLeft: 'auto' }}>
                Mark all complete
              </button>
            )}
          </div>

          {/* Table */}
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #eee', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {colHead('first_name', 'Order')}
                  {colHead('order_date', 'Order Time')}
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Service</th>
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Delivery Status</th>
                  {colHead('transactions_total', 'Total')}
                  <th style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', textAlign: 'left', background: '#F7F8FC' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>Loading…</td></tr>
                )}
                {!loading && orders.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#aaa', fontSize: 13 }}>No orders found</td></tr>
                )}
                {orders.map(order => {
                  const timeColor = statusColor(order.orderStatus, order.orderDate, order.orderTime)
                  const isNew = !order.orderSeenByAdmin
                  return (
                    <tr
                      key={order.orderReference}
                      onClick={() => openOrder(order)}
                      style={{
                        cursor: 'pointer',
                        background: isNew ? 'rgba(107,110,249,0.04)' : undefined,
                        borderTop: '1px solid #f5f5f5',
                        transition: 'background 0.1s',
                      }}
                    >
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ fontWeight: isNew ? 700 : 500, fontSize: 13, color: DARK }}>
                          {order.firstName} {order.lastName}
                          {isNew && <span style={{ marginLeft: 6, background: BLUE, color: '#fff', borderRadius: 4, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>NEW</span>}
                        </div>
                        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>#{order.orderNumber}</div>
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: timeColor || DARK }}>{fmtTime(order.orderTime)}</div>
                        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>{fmtDate(order.orderDate)}</div>
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, color: '#666' }}>
                        {DELIVERY_LABEL[order.deliveryType] || order.orderType || '—'}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 12, color: '#888' }}>
                        {order.nashDeliveryStatus || '—'}
                        {order.nashDeliveryPickupEta && <div style={{ fontSize: 11 }}>Pickup: {order.nashDeliveryPickupEta}</div>}
                      </td>
                      <td style={{ padding: '12px 14px', fontSize: 13, fontWeight: 600, color: DARK }}>
                        {fmt(order.transactionsTotal)}
                      </td>
                      <td style={{ padding: '12px 14px' }}>
                        {TERMINAL.has(order.orderStatus) ? (
                          <span style={{ fontSize: 13, color: '#888' }}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</span>
                        ) : (
                          <select
                            value={order.orderStatus}
                            onClick={e => e.stopPropagation()}
                            onChange={e => {
                              e.stopPropagation()
                              const newStatus = e.target.value
                              if (newStatus === 'CANCELED' || newStatus === 'VOID') {
                                setConfirm({
                                  msg: 'Do you want to cancel? Order status will be changed and customer will be notified.',
                                  action: async () => {
                                    await fetch(`/api/restaurant/orders/${order.orderReference}/status?orderStatus=${newStatus}`, { method: 'PUT' })
                                    loadOrders()
                                  },
                                })
                              } else {
                                fetch(`/api/restaurant/orders/${order.orderReference}/status?orderStatus=${newStatus}`, { method: 'PUT' })
                                  .then(() => loadOrders())
                              }
                            }}
                            style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: F, background: '#fff', color: DARK, outline: 'none', cursor: 'pointer' }}
                          >
                            <option value={order.orderStatus}>{STATUS_LABEL[order.orderStatus] || order.orderStatus}</option>
                            {order.orderStatusesToChange?.map(s => (
                              <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>
                            ))}
                          </select>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
              <div style={{ fontSize: 13, color: '#888' }}>
                {total} orders — page {page + 1} of {totalPages}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setPage(0)} disabled={page === 0}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>«</button>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page === 0 ? 'default' : 'pointer', opacity: page === 0 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>‹</button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  const pg = Math.max(0, Math.min(totalPages - 5, page - 2)) + i
                  return (
                    <button key={pg} onClick={() => setPage(pg)}
                      style={{ padding: '6px 10px', border: '1px solid', borderColor: pg === page ? BLUE : '#ddd', borderRadius: 6, background: pg === page ? BLUE : '#fff', color: pg === page ? '#fff' : DARK, cursor: 'pointer', fontSize: 13, fontFamily: F, fontWeight: pg === page ? 700 : 400 }}>
                      {pg + 1}
                    </button>
                  )
                })}
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>›</button>
                <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}
                  style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 6, background: '#fff', cursor: page >= totalPages - 1 ? 'default' : 'pointer', opacity: page >= totalPages - 1 ? 0.4 : 1, fontSize: 13, fontFamily: F }}>»</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Order Drawer */}
      {drawerRef && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.2)', zIndex: 199 }} onClick={() => setDrawerRef(null)} />
          <OrderDrawer orderRef={drawerRef} onClose={() => setDrawerRef(null)} onOrderUpdated={() => loadOrders()} />
        </>
      )}

      {confirm && <ConfirmDialog message={confirm.msg} onConfirm={() => { confirm.action(); setConfirm(null) }} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersContent />
    </Suspense>
  )
}
