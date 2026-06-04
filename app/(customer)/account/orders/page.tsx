'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import OrderDetailPanel from '../components/OrderDetailPanel'
import NewOrderDialog from './components/NewOrderDialog'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

interface ApiOrder {
  reference?: string
  id?: string
  restaurantName?: string
  restaurant?: { name?: string; businessName?: string }
  orderDate?: string
  deliveryDate?: string
  date?: string
  createdAt?: string
  total?: number
  totalAmount?: number
  status?: string
  orderStatus?: string
  orderType?: string
  serviceType?: string
  headcount?: number
  numberOfPeople?: number
  // FM wire attribution: "DISCO" (3P) or "FAMILYMEAL" (1P). Shown as a small
  // "3P"/"1P" pill; the raw value is never displayed.
  sourceoforder?: string
}

// 3P / 1P attribution pill. "DISCO" → 3P (Disco Blue), "FAMILYMEAL" → 1P
// (gray). Renders nothing for unknown/absent values.
function SourcePill({ source }: { source?: string }) {
  if (source !== 'DISCO' && source !== 'FAMILYMEAL') return null
  const is3P = source === 'DISCO'
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 5px', borderRadius: 4,
      fontSize: 9, fontWeight: 700, letterSpacing: '0.02em', verticalAlign: 'middle',
      color: '#fff', background: is3P ? '#5B6FE8' : '#9090C8',
    }}
      title={is3P ? 'Third-party (marketplace)' : 'First-party (direct link)'}>
      {is3P ? '3P' : '1P'}
    </span>
  )
}

function fmtDateLong(d?: string) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return d }
}
function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }

// ── Calendar ─────────────────────────────────────────────────────────────────

function Calendar({ orders, onOpenOrder, onEmptyDateClick }: { orders: ApiOrder[]; onOpenOrder: (ref: string) => void; onEmptyDateClick: (iso: string) => void }) {
  const now = new Date()
  const [yr, setYr] = useState(now.getFullYear())
  const [mo, setMo] = useState(now.getMonth())
  const first = new Date(yr, mo, 1).getDay()
  const days = new Date(yr, mo + 1, 0).getDate()
  const prev = new Date(yr, mo, 0).getDate()

  const cells: { d: number; cur: boolean; today: boolean }[] = []
  for (let i = 0; i < first; i++) cells.push({ d: prev - first + 1 + i, cur: false, today: false })
  for (let d = 1; d <= days; d++) cells.push({ d, cur: true, today: now.getFullYear() === yr && now.getMonth() === mo && now.getDate() === d })
  const rem = (first + days) % 7
  for (let i = 1; i <= (rem ? 7 - rem : 0); i++) cells.push({ d: i, cur: false, today: false })

  function chM(dir: number) { let m = mo + dir, y = yr; if (m > 11) { m = 0; y++ } if (m < 0) { m = 11; y-- } setMo(m); setYr(y) }

  // Build calendar events from real orders
  const calEvs: Record<number, { label: string; ref: string; status: string }[]> = {}
  orders.forEach(o => {
    const dateStr = o.orderDate || o.deliveryDate || o.date || o.createdAt || ''
    const ref = (o.reference || o.id || '') as string
    if (!dateStr || !ref) return
    try {
      const d = new Date(dateStr)
      if (d.getFullYear() === yr && d.getMonth() === mo) {
        const day = d.getDate()
        if (!calEvs[day]) calEvs[day] = []
        calEvs[day].push({ label: o.restaurantName || o.restaurant?.name || 'Order', ref, status: o.status || '' })
      }
    } catch {}
  })

  function evStyle(status: string): React.CSSProperties {
    const s = (status || '').toUpperCase()
    if (s === 'PAUSED' || s === 'UNPAID') return { background: '#FAEEDA', color: '#633806' }
    if (s === 'COMPLETED' || s === 'PAID') return { background: '#E1F5EE', color: '#085041' }
    return { background: '#EEEDFE', color: '#3C3489' }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{MONTHS[mo]} {yr}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginLeft: 14 }}>
            {/* Legend must match evStyle() above — those are the only three
                colors any cell can render. Recurring/catering split needs
                an order-type flag on the API response before we can show it. */}
            {[{ c: INDIGO, l: 'Upcoming' }, { c: '#1D9E75', l: 'Completed' }, { c: '#BA7517', l: 'Paused' }].map(x => (
              <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: x.c, flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: '#555' }}>{x.l}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => chM(-1)} style={navBtn}>‹</button>
          <button onClick={() => chM(1)} style={navBtn}>›</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', border: '1px solid #e8e8e8', borderRadius: 10, overflow: 'hidden' }}>
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} style={{ background: '#efefef', textAlign: 'center', fontSize: 9, color: '#666', padding: '7px 2px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid #f0f0f0' }}>{d}</div>
        ))}
        {cells.map((cell, i) => {
          const evs = cell.cur ? (calEvs[cell.d] || []) : []
          const cellIso = cell.cur
            ? `${yr}-${String(mo + 1).padStart(2, '0')}-${String(cell.d).padStart(2, '0')}`
            : ''
          const clickable = cell.cur  // empty current-month cells start a new order
          return (
            <div key={i}
              onClick={() => {
                if (!cell.cur) return
                if (evs.length) onOpenOrder(evs[0].ref)
                else onEmptyDateClick(cellIso)
              }}
              style={{ background: cell.today ? '#f0f0ff' : '#fff', minHeight: 72, padding: 6, cursor: clickable ? 'pointer' : 'default', borderRight: '0.5px solid #f5f5f5', borderBottom: '0.5px solid #f5f5f5', opacity: cell.cur ? 1 : 0.3, transition: 'background 0.1s' }}
              onMouseOver={e => { if (clickable) (e.currentTarget as HTMLElement).style.background = '#fafafa' }}
              onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = cell.today ? '#f0f0ff' : '#fff' }}
            >
              <div style={{ fontSize: 10, fontWeight: cell.today ? 700 : 600, color: cell.today ? INDIGO : '#888', marginBottom: 3 }}>{cell.d}</div>
              {evs.map((ev, j) => (
                <div key={j}
                  onClick={e => { e.stopPropagation(); onOpenOrder(ev.ref) }}
                  style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, cursor: 'pointer', ...evStyle(ev.status) }}
                >
                  {ev.label}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── List view ────────────────────────────────────────────────────────────────

function OrderListRow({ o, onClick }: { o: ApiOrder; onClick: () => void }) {
  const name = o.restaurantName || o.restaurant?.name || 'Order'
  const people = o.headcount || o.numberOfPeople
  const service = o.orderType || o.serviceType
  const paid = o.status !== 'UNPAID'
  return (
    <div
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', padding: '11px 10px', borderBottom: '1px solid #f5f5f5', gap: 12, cursor: 'pointer', borderRadius: 8, transition: 'background 0.1s' }}
      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
      onMouseOut={e => (e.currentTarget as HTMLElement).style.background = ''}
    >
      <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: '#1A1028', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 700, fontFamily: "'DM Sans', sans-serif" }}>{(name?.[0] || '·').toUpperCase()}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{name}<SourcePill source={o.sourceoforder} /></div>
        <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>
          {people ? `${people} people · ` : ''}{service ? `${service} · ` : ''}
          <span style={{ color: paid ? '#1D9E75' : '#E24B4A', fontWeight: 600 }}>{paid ? 'Paid' : 'Unpaid'}</span>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{fmtMoney(o.total || o.totalAmount)}</div>
        <div style={{ fontSize: 10, color: '#111', fontWeight: 600, marginTop: 2 }}>{fmtDateLong(o.orderDate || o.deliveryDate || o.createdAt || o.date)}</div>
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const [orders, setOrders] = useState<ApiOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'cal' | 'list'>('cal')
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  // YYYY-MM-DD of an empty calendar cell the user clicked. Drives the
  // NewOrderDialog (favorites picker + embedded restaurant page).
  const [newOrderDate, setNewOrderDate] = useState<string | null>(null)

  const fetchOrders = useCallback(() => {
    setLoading(true)
    fetch('/api/fm-order-history?page=0&size=50', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { content: [] })
      .then(d => {
        const list: ApiOrder[] = d.content || d.orders || d.data || (Array.isArray(d) ? d : [])
        setOrders(list)
      })
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  // Land at the top of the portal on mount (e.g. right after login).
  useEffect(() => { window.scrollTo(0, 0) }, [])

  function openOrder(ref: string) { setSelectedRef(ref) }
  function closeDetail() { setSelectedRef(null) }

  const stats = useMemo(() => {
    const now = new Date()
    const thisMonth = orders.filter(o => {
      try { const d = new Date(o.orderDate || o.createdAt || ''); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() } catch { return false }
    }).length
    let last = ''
    let lastRest = ''
    if (orders[0]) {
      try { last = new Date(orders[0].orderDate || orders[0].createdAt || '').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch {}
      lastRest = orders[0].restaurantName || orders[0].restaurant?.name || ''
    }
    return { total: orders.length, thisMonth, last, lastRest }
  }, [orders])

  return (
    <div style={{ fontFamily: F }}>
      {/* Header with view toggle + New order */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: DARK, margin: 0 }}>Orders</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', background: '#efefef', borderRadius: 8, padding: 2 }}>
            {(['cal', 'list'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: F, background: view === v ? '#fff' : 'transparent', color: view === v ? DARK : '#666', boxShadow: view === v ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
                {v === 'cal' ? 'Calendar' : 'List'}
              </button>
            ))}
          </div>
          <Link href="/fullmap" style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'none' }}>
            + New order
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10, marginBottom: 18 }}>
        {[
          { l: 'Total orders', v: loading ? '…' : String(stats.total), s: 'all time' },
          { l: 'This month', v: loading ? '…' : String(stats.thisMonth), s: MONTHS[new Date().getMonth()] },
          { l: 'Last order', v: loading || !stats.last ? '—' : stats.last, s: stats.lastRest, small: true },
        ].map(s => (
          <div key={s.l} style={{ background: '#efefef', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 10, color: '#666', marginBottom: 4, fontWeight: 600 }}>{s.l}</div>
            <div style={{ fontSize: s.small ? 16 : 22, fontWeight: 700, color: '#111', paddingTop: s.small ? 3 : 0 }}>{s.v}</div>
            <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{s.s}</div>
          </div>
        ))}
      </div>

      {/* Calendar or List */}
      {view === 'cal' ? (
        <Calendar orders={orders} onOpenOrder={openOrder} onEmptyDateClick={setNewOrderDate} />
      ) : loading ? (
        <div style={{ color: '#aaa', fontSize: 13, padding: '20px 0' }}>Loading orders…</div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🪩</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 6 }}>No orders yet</div>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 22 }}>Start exploring catering options</div>
          <Link href="/fullmap" style={{ padding: '10px 24px', background: BLUE, color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
            Browse restaurants
          </Link>
        </div>
      ) : (
        <div style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          {orders.map((o, i) => (
            <OrderListRow key={(o.reference || o.id || i) as string} o={o} onClick={() => openOrder((o.reference || o.id) as string)} />
          ))}
        </div>
      )}

      {/* Detail panel — right slide-in. `key` forces a fresh remount per order
          so clicking a different calendar date never flashes the previous
          order's content before the new one loads (shows the spinner instead). */}
      {selectedRef && (
        <OrderDetailPanel key={selectedRef} orderRef={selectedRef} mode="upcoming" onClose={closeDetail} />
      )}

      {/* New order from a clicked empty calendar cell */}
      {newOrderDate && (
        <NewOrderDialog
          date={newOrderDate}
          onClose={() => setNewOrderDate(null)}
          onOrderPlaced={() => {
            setNewOrderDate(null)
            fetchOrders()
          }}
        />
      )}
    </div>
  )
}

const navBtn: React.CSSProperties = { background: '#f0f0f0', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: F }
