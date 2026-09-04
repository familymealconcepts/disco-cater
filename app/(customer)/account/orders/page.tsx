'use client'
import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import OrderDetailPanel from '../components/OrderDetailPanel'
import NewOrderDialog from './components/NewOrderDialog'
import { getOrderSourceBadge } from '../../../../lib/order-utils'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#586CE1'
const INDIGO = '#6466E8'
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
  itemCount?: number
  orderNumber?: number
}

// orderDate is a bare "YYYY-MM-DD" (no offset) — parses as UTC midnight per
// spec, so routing it through `new Date(d)` + local toLocaleDateString
// silently shows the day before the one actually stored, in any
// UTC-negative timezone. Read the digits directly and format in UTC instead.
// Same fix pattern as lib/order-edit.ts's fmtDateHuman/ae8bdf2 and
// manage-orders/page.tsx's fmtDate.
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
function fmtDateLong(d?: string) {
  if (!d) return ''
  const bareDate = BARE_DATE_RE.exec(d)
  if (bareDate) {
    return new Date(Date.UTC(+bareDate[1], +bareDate[2] - 1, +bareDate[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  }
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return d }
}
function fmtMoney(n?: number) { return `$${(n || 0).toFixed(2)}` }
function fmtDayMonth(d?: string) {
  if (!d) return '—'
  const bareDate = BARE_DATE_RE.exec(d)
  if (bareDate) {
    return new Date(Date.UTC(+bareDate[1], +bareDate[2] - 1, +bareDate[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return d }
}
// Calendar-day components as plain numbers — used wherever this page buckets/
// groups orders by day (the Calendar grid, the mobile Month Agenda, the "this
// month" stat) instead of formatting a display string. A bare order date has
// no time component and parses as UTC midnight per spec, so reading it back
// through local Date getters (getFullYear/getMonth/getDate) reintroduces the
// exact one-day-back shift the fix above prevents for display — read its
// digits directly instead. createdAt (the fallback when no order/delivery
// date exists) is a full timestamp with real zone info, so it's read with
// ordinary local getters, which is correct for it.
function dateParts(d?: string): { y: number; m: number; day: number } | null {
  if (!d) return null
  const bareDate = BARE_DATE_RE.exec(d)
  if (bareDate) return { y: +bareDate[1], m: +bareDate[2] - 1, day: +bareDate[3] }
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return null
  return { y: dt.getFullYear(), m: dt.getMonth(), day: dt.getDate() }
}

// The 7-column calendar grid is unreadable on phones, so we swap it for a
// month-grouped agenda list below this breakpoint.
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const fn = () => setM(mq.matches)
    fn()
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return m
}

function statusPill(status?: string): { label: string; bg: string; color: string } {
  const s = (status || '').toUpperCase()
  if (s === 'COMPLETED' || s === 'PAID') return { label: 'Paid', bg: '#E1F5EE', color: '#085041' }
  if (s === 'UNPAID') return { label: 'Unpaid', bg: '#FAEEDA', color: '#633806' }
  if (s === 'PAUSED') return { label: 'Paused', bg: '#FAEEDA', color: '#633806' }
  if (s) return { label: s.charAt(0) + s.slice(1).toLowerCase(), bg: '#EEEDFE', color: '#3C3489' }
  return { label: 'Upcoming', bg: '#EEEDFE', color: '#3C3489' }
}

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
    const parts = dateParts(dateStr)
    if (parts && parts.y === yr && parts.m === mo) {
      const day = parts.day
      if (!calEvs[day]) calEvs[day] = []
      calEvs[day].push({ label: o.restaurantName || o.restaurant?.name || 'Order', ref, status: o.status || '' })
    }
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
              <div style={{ fontSize: 10, fontWeight: cell.today ? 700 : 600, color: cell.today ? INDIGO : '#727272', marginBottom: 3 }}>{cell.d}</div>
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
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{name}{getOrderSourceBadge(o.sourceoforder || '')}</div>
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

// ── Mobile agenda (month-grouped list) ───────────────────────────────────────

function MonthAgenda({ orders, onOpenOrder }: { orders: ApiOrder[]; onOpenOrder: (ref: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; sort: number; items: { o: ApiOrder; t: number }[] }>()
    for (const o of orders) {
      const ref = (o.reference || o.id || '') as string
      if (!ref) continue
      const dateStr = o.orderDate || o.deliveryDate || o.date || o.createdAt || ''
      const parts = dateParts(dateStr)
      const key = parts ? `${MONTHS[parts.m]} ${parts.y}` : 'Other'
      const sort = parts ? parts.y * 12 + parts.m : -1
      if (!map.has(key)) map.set(key, { key, sort, items: [] })
      // Sort-within-month only — the relative order among same-shaped values
      // (all bare dates share the same UTC-midnight-of-that-day convention)
      // is unaffected by the display bug above, so this doesn't need the
      // dateParts fix; only the day/month bucketing above does.
      const t = dateStr ? new Date(dateStr).getTime() : 0
      map.get(key)!.items.push({ o, t: Number.isFinite(t) ? t : 0 })
    }
    const arr = [...map.values()]
    arr.sort((a, b) => b.sort - a.sort)           // newest month first
    arr.forEach(g => g.items.sort((a, b) => b.t - a.t)) // newest order first within month
    return arr
  }, [orders])

  return (
    <div>
      {groups.map(g => (
        <div key={g.key} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#727272', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px 2px' }}>{g.key}</div>
          <div style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            {g.items.map(({ o }, i) => {
              const ref = (o.reference || o.id || '') as string
              const name = o.restaurantName || o.restaurant?.name || 'Order'
              const dateStr = o.orderDate || o.deliveryDate || o.date || o.createdAt
              const p = statusPill(o.status || o.orderStatus)
              return (
                <div key={ref || i}
                  onClick={() => ref && onOpenOrder(ref)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 12px', borderBottom: i < g.items.length - 1 ? '1px solid #f5f5f5' : 'none', cursor: 'pointer' }}
                >
                  <div style={{ width: 46, flexShrink: 0, fontSize: 11, fontWeight: 700, color: '#111', textAlign: 'center', lineHeight: 1.3 }}>{fmtDayMonth(dateStr)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}{getOrderSourceBadge(o.sourceoforder || '')}</div>
                    <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: p.bg, color: p.color, flexShrink: 0 }}>{p.label}</span>
                      <span style={{ fontSize: 11.5, color: '#727272', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {[o.orderType ? o.orderType.charAt(0) + o.orderType.slice(1).toLowerCase() : null, o.itemCount ? `${o.itemCount} item${o.itemCount === 1 ? '' : 's'}` : null, o.orderNumber ? `#${o.orderNumber}` : null].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111', flexShrink: 0 }}>{fmtMoney(o.total || o.totalAmount)}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const [orders, setOrders] = useState<ApiOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [isError, setIsError] = useState(false)
  const [view, setView] = useState<'cal' | 'list'>('cal')
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  // YYYY-MM-DD of an empty calendar cell the user clicked. Drives the
  // NewOrderDialog (favorites picker + embedded restaurant page).
  const [newOrderDate, setNewOrderDate] = useState<string | null>(null)
  const isMobile = useIsMobile()

  const fetchOrders = useCallback(() => {
    setLoading(true)
    setIsError(false)
    fetch('/api/fm-order-history?page=0&size=50', { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error('Failed to load orders')
        return r.json()
      })
      .then(d => {
        const list: ApiOrder[] = d.content || d.orders || d.data || (Array.isArray(d) ? d : [])
        setOrders(list)
      })
      .catch(() => { setOrders([]); setIsError(true) })
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
      const parts = dateParts(o.orderDate || o.createdAt || '')
      return !!parts && parts.m === now.getMonth() && parts.y === now.getFullYear()
    }).length
    let last = ''
    let lastRest = ''
    if (orders[0]) {
      last = fmtDayMonth(orders[0].orderDate || orders[0].createdAt || '')
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

      {/* Calendar or List — friendly empty state (any view) when there are no orders */}
      {loading ? (
        <div style={{ color: '#727272', fontSize: 13, padding: '20px 0' }}>Loading orders…</div>
      ) : isError ? (
        <div style={{ textAlign: 'center', padding: '64px 24px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>⚠️</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>Couldn&apos;t load your orders</div>
          <div style={{ fontSize: 14, color: '#727272', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>Something went wrong. Please try again.</div>
          <button onClick={fetchOrders} style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', border: 'none', borderRadius: 999, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
            Retry
          </button>
        </div>
      ) : orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '64px 24px' }}>
          <div style={{ fontSize: 48, marginBottom: 16, lineHeight: 1 }}>🍽️</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: DARK, marginBottom: 8 }}>No orders yet</div>
          <div style={{ fontSize: 14, color: '#727272', lineHeight: 1.5, maxWidth: 340, margin: '0 auto 22px' }}>When you place a catering order, it&apos;ll show up here.</div>
          <Link href="/fullmap" style={{ display: 'inline-block', padding: '11px 24px', background: BLUE, color: '#fff', borderRadius: 999, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
            Find a restaurant
          </Link>
        </div>
      ) : view === 'cal' ? (
        isMobile
          ? <MonthAgenda orders={orders} onOpenOrder={openOrder} />
          : <Calendar orders={orders} onOpenOrder={openOrder} onEmptyDateClick={setNewOrderDate} />
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
