'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatTime12 } from '../../../../../../lib/utils/time'
import { fulfillmentLabel } from '../../../../../../lib/order/fulfillment-label'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const PURPLE = '#6B6EF9'
const BLUE = '#5B6FE8'
const MAGENTA = '#C044C8'
const PINK = '#F0468A'
const GOLD = '#EFB84A'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// What the kitchen actually has to cook, plus what it already cooked this month.
// CANCELED / CANCELLED / VOID / VOIDED / EXPIRED / REFUND / PARTIAL_REFUND are all
// excluded: a cancelled order on a calendar is worse than no order at all.
// UNPAID is INCLUDED deliberately — a native invoice order is a real booking the
// kitchen must prepare, it simply has not been collected yet, and it is badged.
const CALENDAR_STATUSES = ['DUE', 'PAID', 'UNPAID', 'RESERVED', 'COMPLETED']

export interface CalendarOrder {
  orderReference: string
  orderNumber: number
  firstName: string
  lastName: string
  companyName?: string
  restaurantName?: string
  orderDate: string
  orderTime: string
  orderType: string
  deliveryType: string
  transactionsTotal: number
  orderStatus: string
}

// Same 768px swap the diner calendar uses: a 7-column grid is unreadable on a
// phone, and Taylor reads this between locations on hers.
function useIsMobile(): boolean {
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

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`

// A stable per-location accent, so the same location is the same colour every
// month without needing a lookup table. Only used when several are in view.
const LOCATION_COLORS = [PURPLE, MAGENTA, PINK, BLUE, GOLD, '#7E57C2']
function locationColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return LOCATION_COLORS[h % LOCATION_COLORS.length]
}
// "Apollo Bagels - Kips Bay" -> "Kips Bay". Nine Apollo locations differ only by
// the suffix, so the prefix is nine-tenths noise in a calendar cell.
function shortLocation(name?: string): string {
  if (!name) return ''
  const parts = name.split(' - ')
  return (parts.length > 1 ? parts[parts.length - 1] : name).trim()
}

function customerLabel(o: CalendarOrder): string {
  const person = `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim()
  return o.companyName?.trim() || person || 'Customer'
}

export default function OrdersCalendar({ onOpenOrder }: { onOpenOrder: (ref: string) => void }) {
  const isMobile = useIsMobile()
  const today = useMemo(() => new Date(), [])
  const [yr, setYr] = useState(today.getFullYear())
  const [mo, setMo] = useState(today.getMonth())
  const [orders, setOrders] = useState<CalendarOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [multiLocation, setMultiLocation] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const first = `${yr}-${String(mo + 1).padStart(2, '0')}-01`
    const lastDay = new Date(yr, mo + 1, 0).getDate()
    const last = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    try {
      // ONE request for the whole month, not one per order or per day. The route
      // caps a page at 200, so a very busy chain-month pages on — still a couple
      // of requests for the month. Scope, access and role gating all come from
      // /api/restaurant/orders itself, so this view can never reach a location
      // the Orders tab could not.
      const collected: CalendarOrder[] = []
      let page = 0
      for (;;) {
        const p = new URLSearchParams({ page: String(page), size: '200', fromDate: first, toDate: last })
        CALENDAR_STATUSES.forEach(s => p.append('orderStatuses', s))
        const res = await fetch(`/api/restaurant/orders?${p}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const d = await res.json()
        collected.push(...((d.content || []) as CalendarOrder[]))
        // The scope the RESPONSE was built from — never localStorage. This decides
        // whether a location tag is worth showing at all.
        if (d.scope && typeof d.scope.mode === 'string') setMultiLocation(d.scope.mode === 'aggregate')
        page += 1
        if (page >= (d.totalPages || 1)) break
      }
      setOrders(collected)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the calendar.')
      setOrders([])
    } finally { setLoading(false) }
  }, [yr, mo])

  useEffect(() => { load() }, [load])

  const byDay = useMemo(() => {
    const m = new Map<number, CalendarOrder[]>()
    for (const o of orders) {
      const day = Number(String(o.orderDate || '').slice(8, 10))
      if (!day) continue
      const arr = m.get(day) || []
      arr.push(o)
      m.set(day, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => String(a.orderTime).localeCompare(String(b.orderTime)))
    return m
  }, [orders])

  const chM = (delta: number) => {
    const d = new Date(yr, mo + delta, 1)
    setYr(d.getFullYear()); setMo(d.getMonth())
  }

  const monthTotal = orders.reduce((s, o) => s + (Number(o.transactionsTotal) || 0), 0)

  const navBtn: React.CSSProperties = {
    width: 30, height: 30, borderRadius: 8, border: '1px solid #e7e4f2', background: '#fff',
    color: DARK, cursor: 'pointer', fontSize: 15, lineHeight: 1, fontFamily: F,
  }

  const OrderChip = ({ o, compact }: { o: CalendarOrder; compact: boolean }) => {
    const unpaid = String(o.orderStatus).toUpperCase() === 'UNPAID'
    const loc = shortLocation(o.restaurantName)
    return (
      <button
        onClick={() => onOpenOrder(o.orderReference)}
        title={`${customerLabel(o)} — ${money(o.transactionsTotal)}${loc ? ` — ${loc}` : ''}`}
        style={{
          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', fontFamily: F,
          background: unpaid ? 'rgba(239,184,74,0.10)' : '#faf9ff',
          border: '1px solid ' + (unpaid ? 'rgba(239,184,74,0.55)' : '#ece9f6'),
          borderLeft: multiLocation && loc ? `3px solid ${locationColor(loc)}` : undefined,
          borderRadius: 7, padding: compact ? '4px 6px' : '7px 9px', marginBottom: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, justifyContent: 'space-between' }}>
          <span style={{ fontSize: compact ? 10 : 12, fontWeight: 700, color: DARK, whiteSpace: 'nowrap' }}>
            {formatTime12(o.orderTime)}
          </span>
          <span style={{ fontSize: compact ? 10 : 12, fontWeight: 700, color: DARK, whiteSpace: 'nowrap' }}>
            {money(o.transactionsTotal)}
          </span>
        </div>
        <div style={{ fontSize: compact ? 10 : 12, color: '#444', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {customerLabel(o)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1, flexWrap: 'wrap' }}>
          <span style={{ fontSize: compact ? 9 : 10.5, color: '#8b86a8' }}>
            {fulfillmentLabel(o.deliveryType, o.orderType)}
          </span>
          {multiLocation && loc && (
            <span style={{ fontSize: compact ? 9 : 10.5, color: locationColor(loc), fontWeight: 600 }}>· {loc}</span>
          )}
          {unpaid && (
            <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.06em', color: '#8A6100', background: 'rgba(239,184,74,0.35)', borderRadius: 4, padding: '1px 4px' }}>UNPAID</span>
          )}
        </div>
      </button>
    )
  }

  const firstWeekday = new Date(yr, mo, 1).getDay()
  const daysInMonth = new Date(yr, mo + 1, 0).getDate()
  const cells: { d: number; cur: boolean }[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push({ d: 0, cur: false })
  for (let d = 1; d <= daysInMonth; d++) cells.push({ d, cur: true })
  while (cells.length % 7 !== 0) cells.push({ d: 0, cur: false })

  const isToday = (d: number) => today.getFullYear() === yr && today.getMonth() === mo && today.getDate() === d

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{MONTHS[mo]} {yr}</span>
          <span style={{ fontSize: 12, color: '#8b86a8' }}>
            {loading ? 'Loading…' : `${orders.length} order${orders.length === 1 ? '' : 's'} · ${money(monthTotal)}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => { setYr(today.getFullYear()); setMo(today.getMonth()) }}
            style={{ ...navBtn, width: 'auto', padding: '0 12px', fontSize: 12, fontWeight: 600 }}>Today</button>
          <button onClick={() => chM(-1)} style={navBtn} aria-label="Previous month">‹</button>
          <button onClick={() => chM(1)} style={navBtn} aria-label="Next month">›</button>
        </div>
      </div>

      {multiLocation && (
        <div style={{ fontSize: 11.5, color: '#8b86a8', marginBottom: 10 }}>
          Showing every location you can reach — each order is tagged with its location.
        </div>
      )}

      {error && (
        <div style={{ background: 'rgba(240,70,138,0.06)', border: '1px solid rgba(240,70,138,0.3)', color: DARK, padding: '10px 14px', borderRadius: 10, fontSize: 12.5, marginBottom: 12 }}>
          Couldn’t load the calendar ({error}). Try the arrows again or reload.
        </div>
      )}

      {isMobile ? (
        <div>
          {!loading && orders.length === 0 && (
            <div style={{ textAlign: 'center', color: '#aaa', fontSize: 13, padding: '28px 0' }}>No orders this month.</div>
          )}
          {Array.from(byDay.keys()).sort((a, b) => a - b).map(day => (
            <div key={day} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{
                  fontSize: 12, fontWeight: 800, color: isToday(day) ? '#fff' : DARK,
                  background: isToday(day) ? PURPLE : 'transparent', borderRadius: 6, padding: isToday(day) ? '2px 8px' : 0,
                }}>
                  {MONTHS[mo].slice(0, 3)} {day}
                </span>
                <span style={{ fontSize: 11, color: '#8b86a8' }}>{(byDay.get(day) || []).length} order{(byDay.get(day) || []).length === 1 ? '' : 's'}</span>
              </div>
              {(byDay.get(day) || []).map(o => <OrderChip key={o.orderReference} o={o} compact={false} />)}
            </div>
          ))}
        </div>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(7,1fr)',
          border: '1px solid #ece9f6', borderRadius: 14, overflow: 'hidden', background: '#fff',
        }}>
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
            <div key={d} style={{ background: '#faf9ff', textAlign: 'center', fontSize: 9, color: '#8b86a8', padding: '9px 2px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid #ece9f6' }}>{d}</div>
          ))}
          {cells.map((cell, i) => {
            const evs = cell.cur ? (byDay.get(cell.d) || []) : []
            return (
              <div key={i} style={{
                minHeight: 112, borderRight: (i % 7 === 6) ? 'none' : '1px solid #f2f0fa',
                borderBottom: '1px solid #f2f0fa', padding: 6,
                background: cell.cur ? (isToday(cell.d) ? 'rgba(107,110,249,0.05)' : '#fff') : '#fcfcfe',
              }}>
                {cell.cur && (
                  <div style={{
                    fontSize: 10.5, fontWeight: 800, marginBottom: 4,
                    color: isToday(cell.d) ? '#fff' : '#8b86a8',
                    background: isToday(cell.d) ? PURPLE : 'transparent',
                    borderRadius: 5, display: 'inline-block', padding: isToday(cell.d) ? '1px 6px' : 0,
                  }}>{cell.d}</div>
                )}
                {evs.map(o => <OrderChip key={o.orderReference} o={o} compact />)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
