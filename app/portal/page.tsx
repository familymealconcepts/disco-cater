'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'

// ── Brand ─────────────────────────────────────────────────────────────────────
const PURPLE = '#6B6EF9'
const MAGENTA = '#C044C8'
const PINK = '#F0468A'
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GOLD = '#EFB84A'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'
const STORAGE_KEY = 'disco_user'

// ── Types ─────────────────────────────────────────────────────────────────────
type Tab = 'orders' | 'subscriptions' | 'history' | 'favorites' | 'account'
type OrderView = 'list' | 'calendar'

interface Order {
  id: string; restaurant: string; emoji: string; people: number
  type: string; paid: boolean; orderType: string; amount: number
  date: string; status: 'active' | 'paused' | 'past'
  items?: { name: string; price: string }[]
  service?: string; orderDate?: string; orderTime?: string
}

// ── Mock data ─────────────────────────────────────────────────────────────────
const UPCOMING: Order[] = [
  { id: '1', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paid: true, orderType: 'Weekly recurring', amount: 1240, date: 'May 6, 12:00 PM', status: 'active', items: [{ name: 'Team Lunch Box (x1)', price: '$28/pp' }, { name: 'Hummus & Pita Add-on', price: '$4/pp' }, { name: 'Beverages (x40)', price: '$3/pp' }], service: 'Delivery', orderDate: 'Every Tuesday', orderTime: '12:00 PM' },
  { id: '2', restaurant: 'Son del Norte — LES', emoji: '🌮', people: 60, type: 'Delivery', paid: true, orderType: 'Event catering', amount: 2100, date: 'May 14, 11:30 AM', status: 'active', items: [{ name: 'Taco Bar Deluxe (x1)', price: '$30/pp' }, { name: 'Guac & Chips Station', price: '$5/pp' }], service: 'Delivery', orderDate: 'May 14, 2026', orderTime: '11:30 AM' },
  { id: '3', restaurant: 'Pecking House', emoji: '🥢', people: 25, type: 'Pickup', paid: false, orderType: 'Paused — payment failed', amount: 680, date: 'Paused', status: 'paused', items: [{ name: 'Office Feast (x1)', price: '$26/pp' }, { name: 'Spring Rolls (x25)', price: '$2/pp' }], service: 'Pickup', orderDate: 'Bi-weekly', orderTime: '12:30 PM' },
  { id: '4', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paid: true, orderType: 'Weekly recurring', amount: 1240, date: 'May 13, 12:00 PM', status: 'active' },
]
const PAST: Order[] = [
  { id: '5', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paid: true, orderType: 'Weekly recurring', amount: 1240, date: 'Apr 29, 2026', status: 'past' },
  { id: '6', restaurant: 'Son del Norte — LES', emoji: '🌮', people: 55, type: 'Delivery', paid: true, orderType: 'Event catering', amount: 1925, date: 'Apr 22, 2026', status: 'past' },
  { id: '7', restaurant: 'Taim — Nolita', emoji: '🥙', people: 40, type: 'Delivery', paid: true, orderType: 'Weekly recurring', amount: 1240, date: 'Apr 15, 2026', status: 'past' },
  { id: '8', restaurant: 'Pecking House', emoji: '🥢', people: 25, type: 'Pickup', paid: true, orderType: 'Bi-weekly', amount: 680, date: 'Apr 8, 2026', status: 'past' },
]
const FAVORITES_DATA = [
  { id: '1', name: 'Taim — Nolita', emoji: '🥙', cuisine: 'Mediterranean', location: 'New York, NY' },
  { id: '2', name: 'Son del Norte — LES', emoji: '🌮', cuisine: 'Mexican', location: 'New York, NY' },
  { id: '3', name: 'Pecking House', emoji: '🥢', cuisine: 'Chinese', location: 'New York, NY' },
  { id: '4', name: '5ive Spice LES', emoji: '🌶️', cuisine: 'Asian Fusion', location: 'New York, NY' },
  { id: '5', name: 'Melt Shop', emoji: '🥪', cuisine: 'American', location: 'New York, NY' },
]
const CALENDAR_EVENTS: Record<string, { type: 'recurring' | 'catering' | 'paused'; label: string }[]> = {
  '2026-05-06': [{ type: 'recurring', label: 'Taim — Nolita' }],
  '2026-05-12': [{ type: 'recurring', label: 'Taim — Nolita' }],
  '2026-05-13': [{ type: 'catering', label: 'Son del Norte' }],
  '2026-05-14': [{ type: 'catering', label: 'Son del Norte' }],
  '2026-05-19': [{ type: 'recurring', label: 'Taim — Nolita' }],
  '2026-05-20': [{ type: 'paused', label: 'Pecking House' }],
  '2026-05-26': [{ type: 'recurring', label: 'Taim — Nolita' }],
  '2026-05-27': [{ type: 'catering', label: 'Team offsite' }],
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const F = "'DM Sans', sans-serif"

// ── Order Detail Panel ─────────────────────────────────────────────────────────
function OrderDetail({ order, onClose }: { order: Order; onClose: () => void }) {
  const isPaused = order.status === 'paused'
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', pointerEvents: 'none' }}>
      <div onClick={onClose} style={{ flex: 1, pointerEvents: 'auto' }} />
      <div style={{ width: 340, background: '#fff', boxShadow: '-4px 0 32px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', pointerEvents: 'auto', animation: 'slideInRight 0.22s ease' }}>
        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: F, marginBottom: 4 }}>Order detail</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: DARK, fontFamily: F }}>{order.restaurant}</div>
            <div style={{ fontSize: 13, color: '#888', fontFamily: F, marginTop: 2 }}>{order.people} people · {order.orderType}</div>
          </div>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {/* Amount + date */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: DARK, letterSpacing: '-0.03em', fontFamily: F }}>${order.amount.toLocaleString()}</div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: DARK, fontFamily: F }}>{order.date}</div>
              <div style={{ fontSize: 11, color: isPaused ? PINK : '#22c55e', fontWeight: 700, marginTop: 2, fontFamily: F }}>{isPaused ? 'Paused' : 'Paid'}</div>
            </div>
          </div>

          {/* Items */}
          {order.items && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: F, marginBottom: 8 }}>Items</div>
              {order.items.map((item, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f5f5f5' }}>
                  <span style={{ fontSize: 13, color: DARK, fontFamily: F }}>{item.name}</span>
                  <span style={{ fontSize: 13, color: '#888', fontFamily: F }}>{item.price}</span>
                </div>
              ))}
            </div>
          )}

          {/* Details */}
          <div style={{ background: '#F8F8FF', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
            {[
              ['Type', order.orderType],
              ['Service', order.service || order.type],
              ['Order date', order.orderDate || order.date],
              ['Order time', order.orderTime || '—'],
              ['Payment', order.paid ? 'Paid' : 'Unpaid'],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #eeebff' }}>
                <span style={{ fontSize: 12, color: '#888', fontFamily: F }}>{label}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: DARK, fontFamily: F }}>{value}</span>
              </div>
            ))}
          </div>

          {/* Paused warning */}
          {isPaused && (
            <div style={{ background: '#FFF0F3', border: '1px solid #FFD0DC', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: PINK, fontWeight: 600, fontFamily: F }}>
              ⚠️ Payment failed — update your card to resume this order.
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', gap: 10 }}>
          {isPaused ? (
            <button style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Update card</button>
          ) : order.status === 'active' ? (
            <>
              <button style={{ flex: 1, padding: '12px', fontSize: 13, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Edit</button>
              <button style={{ flex: 1, padding: '12px', fontSize: 13, fontWeight: 600, color: '#666', background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Skip next</button>
            </>
          ) : (
            <button style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Reorder</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Calendar ───────────────────────────────────────────────────────────────────
function CalendarView({ onDayClick }: { onDayClick: (events: typeof CALENDAR_EVENTS[string]) => void }) {
  const now = new Date()
  const [yr, setYr] = useState(now.getFullYear())
  const [mo, setMo] = useState(now.getMonth())

  const dim = new Date(yr, mo + 1, 0).getDate()
  const fd = new Date(yr, mo, 1).getDay()
  const cells: (number | null)[] = []
  for (let i = 0; i < fd; i++) cells.push(null)
  for (let d = 1; d <= dim; d++) cells.push(d)

  const prev = () => mo === 0 ? (setMo(11), setYr(y => y - 1)) : setMo(m => m - 1)
  const next = () => mo === 11 ? (setMo(0), setYr(y => y + 1)) : setMo(m => m + 1)

  return (
    <div style={{ background: '#fff', border: '1.5px solid #eee', borderRadius: 16, overflow: 'hidden' }}>
      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F }}>{MONTHS[mo]} {yr}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { color: PURPLE, label: 'Recurring' },
              { color: '#22c55e', label: 'Catering' },
              { color: GOLD, label: 'Paused' },
            ].map(l => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />
                <span style={{ fontSize: 11, color: '#888', fontFamily: F }}>{l.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={prev} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>‹</button>
          <button onClick={next} style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>›</button>
        </div>
      </div>

      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
        {DAYS.map(d => <div key={d} style={{ padding: '8px 0', textAlign: 'center', fontSize: 11, fontWeight: 600, color: '#bbb', fontFamily: F }}>{d}</div>)}
      </div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} style={{ minHeight: 80, borderRight: '1px solid #f5f5f5', borderBottom: '1px solid #f5f5f5', background: '#fafafa' }} />
          const key = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const evs = CALENDAR_EVENTS[key] || []
          const isToday = day === now.getDate() && mo === now.getMonth() && yr === now.getFullYear()
          return (
            <div key={day} onClick={() => evs.length && onDayClick(evs)} style={{ minHeight: 80, padding: '6px 6px 4px', borderRight: '1px solid #f5f5f5', borderBottom: '1px solid #f5f5f5', cursor: evs.length ? 'pointer' : 'default', transition: 'background 0.1s' }}
              onMouseOver={e => { if (evs.length) (e.currentTarget as HTMLElement).style.background = '#F8F8FF' }}
              onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = '' }}
            >
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: isToday ? PURPLE : 'transparent', color: isToday ? '#fff' : '#444', fontSize: 12, fontWeight: isToday ? 700 : 400, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 3, fontFamily: F }}>{day}</div>
              {evs.map((ev, j) => (
                <div key={j} style={{ fontSize: 10, fontWeight: 600, padding: '2px 5px', borderRadius: 4, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: ev.type === 'recurring' ? '#EEF0FF' : ev.type === 'catering' ? '#F0FDF4' : '#FFF8EC', color: ev.type === 'recurring' ? PURPLE : ev.type === 'catering' ? '#16a34a' : '#92600A', fontFamily: F }}>{ev.label}</div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Order Row ──────────────────────────────────────────────────────────────────
function OrderRow({ order, onSelect }: { order: Order; onSelect: () => void }) {
  const isPaused = order.status === 'paused'
  return (
    <div onClick={onSelect} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: '#fff', border: `1.5px solid ${isPaused ? '#FFE0E8' : '#f0f0f0'}`, borderRadius: 14, cursor: 'pointer', transition: 'all 0.15s' }}
      onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = isPaused ? PINK : PURPLE; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(107,110,249,0.08)' }}
      onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = isPaused ? '#FFE0E8' : '#f0f0f0'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
    >
      <div style={{ width: 44, height: 44, borderRadius: 10, background: isPaused ? '#FFF0F3' : '#F5F4FF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{order.emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 2 }}>{order.restaurant}</div>
        <div style={{ fontSize: 12, color: '#888', fontFamily: F }}>{order.people} people · {order.type} · {isPaused ? <span style={{ color: PINK, fontWeight: 600 }}>Paused — payment failed</span> : order.paid ? 'Paid' : 'Unpaid'}</div>
        <div style={{ fontSize: 11, color: '#aaa', fontFamily: F, marginTop: 2 }}>{order.orderType}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: DARK, fontFamily: F }}>${order.amount.toLocaleString()}</div>
        <div style={{ fontSize: 11, color: isPaused ? PINK : '#888', fontWeight: isPaused ? 700 : 400, fontFamily: F, marginTop: 2 }}>{order.date}</div>
      </div>
    </div>
  )
}

// ── Orders Tab ─────────────────────────────────────────────────────────────────
function OrdersTab() {
  const [view, setView] = useState<OrderView>('list')
  const [selected, setSelected] = useState<Order | null>(null)
  const [showPast, setShowPast] = useState(false)

  return (
    <div>
      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Active orders', value: '3', sub: '2 recurring · 1 one-time' },
          { label: 'Total orders placed', value: '47', sub: 'since Jan 2025' },
          { label: 'Next order', value: 'May 6', sub: 'Taim — Nolita · 12:00 PM' },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: F, marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: DARK, letterSpacing: '-0.03em', fontFamily: F }}>{s.value}</div>
            <div style={{ fontSize: 11, color: '#aaa', fontFamily: F, marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Toggle + new order */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', background: '#f0f0f0', borderRadius: 8, padding: 3, gap: 2 }}>
          {(['list', 'calendar'] as const).map(v => (
            <button key={v} onClick={() => setView(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: view === v ? '#fff' : 'transparent', color: view === v ? DARK : '#888', fontSize: 12, fontWeight: view === v ? 700 : 500, cursor: 'pointer', fontFamily: F, boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.12s' }}>
              {v === 'list' ? 'List' : 'Calendar'}
            </button>
          ))}
        </div>
        <Link href="/fullmap" style={{ fontSize: 13, fontWeight: 600, color: PURPLE, textDecoration: 'none', fontFamily: F }}>+ New order</Link>
      </div>

      {view === 'calendar' && (
        <CalendarView onDayClick={evs => {
          const match = UPCOMING.find(o => evs.some(e => o.restaurant.includes(e.label.split(' ')[0])))
          if (match) setSelected(match)
        }} />
      )}

      {view === 'list' && (
        <>
          {/* Upcoming label */}
          <div style={{ fontSize: 12, fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: F, marginBottom: 10 }}>Upcoming</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {UPCOMING.map(o => <OrderRow key={o.id} order={o} onSelect={() => setSelected(o)} />)}
          </div>

          {/* Past orders toggle */}
          <button onClick={() => setShowPast(v => !v)} style={{ fontSize: 13, fontWeight: 600, color: '#888', background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 12px', fontFamily: F, display: 'flex', alignItems: 'center', gap: 6 }}>
            Past orders ({PAST.length}) {showPast ? '▴' : '▾'}
          </button>

          {showPast && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
              {PAST.map(o => <OrderRow key={o.id} order={o} onSelect={() => setSelected(o)} />)}
            </div>
          )}

          {/* Discover CTA */}
          <Link href="/fullmap" style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg, #F5F4FF, #FFF0F8)', border: '1.5px solid #eeebff', borderRadius: 14, padding: '14px 18px', textDecoration: 'none' }}>
            <span style={{ fontSize: 20 }}>🪩</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: DARK, fontFamily: F }}>Discover more restaurants</div>
              <div style={{ fontSize: 12, color: '#888', fontFamily: F }}>Find new catering options on Disco Cater →</div>
            </div>
          </Link>
        </>
      )}

      {selected && <OrderDetail order={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

// ── Subscriptions Tab ──────────────────────────────────────────────────────────
function SubscriptionsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[
        { emoji: '🥙', name: 'Taim — Nolita', people: 40, service: 'Delivery', schedule: 'Every Tuesday · 12:00 PM', amount: 1240, next: 'May 6', status: 'active' },
        { emoji: '🥢', name: 'Pecking House', people: 25, service: 'Pickup', schedule: 'Bi-weekly · Paused — payment failed', amount: 680, next: 'Paused', status: 'paused' },
      ].map(sub => (
        <div key={sub.name} style={{ background: '#fff', border: `1.5px solid ${sub.status === 'paused' ? '#FFE0E8' : '#f0f0f0'}`, borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: sub.status === 'paused' ? '#FFF0F3' : '#F5F4FF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{sub.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 2 }}>{sub.name}</div>
              <div style={{ fontSize: 12, color: '#888', fontFamily: F, marginBottom: 8 }}>{sub.people} people · {sub.service}</div>
              <div style={{ fontSize: 12, color: sub.status === 'paused' ? PINK : '#666', fontWeight: sub.status === 'paused' ? 700 : 400, fontFamily: F, marginBottom: 14 }}>{sub.schedule}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {sub.status === 'paused' ? (
                  <button style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Update card</button>
                ) : (
                  <>
                    <button style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, color: DARK, background: '#f5f5f5', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Edit</button>
                    <button style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, color: DARK, background: '#f5f5f5', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Skip next</button>
                  </>
                )}
                <button style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, color: '#999', background: 'none', border: '1.5px solid #eee', borderRadius: 8, cursor: 'pointer', fontFamily: F }}>Cancel subscription</button>
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: DARK, fontFamily: F }}>${sub.amount.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: sub.status === 'paused' ? PINK : '#aaa', fontWeight: sub.status === 'paused' ? 700 : 400, fontFamily: F, marginTop: 4 }}>Next: {sub.next}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── History Tab ────────────────────────────────────────────────────────────────
function HistoryTab() {
  const all = [...UPCOMING, ...PAST]
  const [selected, setSelected] = useState<Order | null>(null)
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {all.map(o => <OrderRow key={o.id} order={o} onSelect={() => setSelected(o)} />)}
      </div>
      <Link href="/fullmap" style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg, #F5F4FF, #FFF0F8)', border: '1.5px solid #eeebff', borderRadius: 14, padding: '14px 18px', textDecoration: 'none' }}>
        <span style={{ fontSize: 20 }}>🪩</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: DARK, fontFamily: F }}>Discover more restaurants</div>
          <div style={{ fontSize: 12, color: '#888', fontFamily: F }}>Find new catering options on Disco Cater →</div>
        </div>
      </Link>
      {selected && <OrderDetail order={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

// ── Favorites Tab ──────────────────────────────────────────────────────────────
function FavoritesTab() {
  const [favs, setFavs] = useState(FAVORITES_DATA)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {favs.map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: '#F5F4FF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{f.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F }}>{f.name}</div>
            <div style={{ fontSize: 12, color: '#888', fontFamily: F }}>{f.cuisine} · {f.location}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/fullmap" style={{ padding: '7px 14px', fontSize: 12, fontWeight: 700, color: '#fff', background: BLUE, borderRadius: 8, textDecoration: 'none', fontFamily: F }}>Order catering</Link>
            <button onClick={() => setFavs(p => p.filter(x => x.id !== f.id))} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #eee', background: '#fff', cursor: 'pointer', color: '#ccc', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
          </div>
        </div>
      ))}
      {favs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🤍</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#888', marginBottom: 16 }}>No saved restaurants yet</div>
          <Link href="/fullmap" style={{ display: 'inline-block', padding: '10px 20px', background: DARK, color: '#fff', borderRadius: 10, textDecoration: 'none', fontSize: 13, fontWeight: 700 }}>Browse restaurants</Link>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: F, marginBottom: 10 }}>Discover more options</div>
        <Link href="/fullmap" style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'linear-gradient(135deg, #F5F4FF, #FFF0F8)', border: '1.5px solid #eeebff', borderRadius: 14, padding: '14px 18px', textDecoration: 'none' }}>
          <span style={{ fontSize: 20 }}>🪩</span>
          <div style={{ fontSize: 13, fontWeight: 700, color: DARK, fontFamily: F }}>Browse Disco Cater</div>
        </Link>
      </div>
    </div>
  )
}

// ── Account Tab ────────────────────────────────────────────────────────────────
function AccountTab({ onSignOut }: { onSignOut: () => void }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const u = JSON.parse(stored)
      setFirstName(u.firstName || '')
      setLastName(u.lastName || '')
      setEmail(u.email || '')
      setPhone(u.phoneNumber || '')
    } catch {}
  }, [])

  async function handleSave() {
    setSaving(true)
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const u = JSON.parse(stored)
      await fetch('/api/fm-user', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${u.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, phoneNumber: phone }),
      })
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...u, firstName, lastName, email, phoneNumber: phone }))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {}
    finally { setSaving(false) }
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: F, color: DARK, boxSizing: 'border-box', transition: 'border-color 0.15s' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Personal info */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 16 }}>Personal info</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>First name</label>
            <input value={firstName} onChange={e => setFirstName(e.target.value)} style={inputStyle} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>Last name</label>
            <input value={lastName} onChange={e => setLastName(e.target.value)} style={inputStyle} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>Email address</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>Phone number</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} style={inputStyle} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
        </div>
        <button onClick={handleSave} disabled={saving} style={{ padding: '10px 22px', fontSize: 13, fontWeight: 700, color: '#fff', background: saved ? '#22c55e' : DARK, border: 'none', borderRadius: 10, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: F, transition: 'background 0.2s' }}>
          {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {/* Addresses */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 16 }}>Addresses</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {['Home address', 'Work address'].map(label => (
            <div key={label}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>{label}</label>
              <input placeholder="Add address" style={{ ...inputStyle, color: '#aaa' }} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
            </div>
          ))}
        </div>
      </div>

      {/* Payment methods */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 16 }}>Payment methods</div>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>💳</div>
          <div style={{ fontSize: 13, color: '#888', fontFamily: F, marginBottom: 14 }}>No payment method on file</div>
          <button style={{ padding: '9px 18px', fontSize: 13, fontWeight: 700, color: DARK, background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>+ Add payment method</button>
        </div>
      </div>

      {/* Notifications */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 4 }}>Notifications</div>
        <div style={{ fontSize: 12, color: '#888', fontFamily: F, marginBottom: 12 }}>No new notifications</div>
      </div>

      {/* Security */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 16 }}>Security</div>
        {['Current password', 'New password', 'Confirm password'].map(label => (
          <div key={label} style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5, fontFamily: F }}>{label}</label>
            <input type="password" placeholder="••••••••" style={inputStyle} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
          </div>
        ))}
        <button style={{ padding: '10px 22px', fontSize: 13, fontWeight: 700, color: '#fff', background: DARK, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Save changes</button>
      </div>

      {/* Sign out */}
      <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F, marginBottom: 8 }}>Sign out</div>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 14px', fontFamily: F }}>You will need to sign in again to access your orders and saved restaurants.</p>
        <button onClick={onSignOut} style={{ padding: '10px 22px', fontSize: 13, fontWeight: 700, color: '#666', background: '#f5f5f5', border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Sign out</button>
      </div>

      {/* Danger zone */}
      <div style={{ background: '#fff', border: '1.5px solid #FFE0E8', borderRadius: 14, padding: '20px' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: PINK, fontFamily: F, marginBottom: 8 }}>Danger zone</div>
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 14px', fontFamily: F }}>Permanently delete your Disco Cater account and all associated order history. This action cannot be undone.</p>
        <button style={{ padding: '10px 22px', fontSize: 13, fontWeight: 700, color: PINK, background: '#FFF0F3', border: '1.5px solid #FFD0DC', borderRadius: 10, cursor: 'pointer', fontFamily: F }}>Delete my account</button>
      </div>
    </div>
  )
}

// ── Login ─────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (user: any) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Please enter your email and password.'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/fm-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Invalid email or password.'); setLoading(false); return }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      onLogin(data)
    } catch { setError('Something went wrong. Please try again.') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8F8FC', fontFamily: F, padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 400, padding: 36, boxShadow: '0 8px 40px rgba(107,110,249,0.10)' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>🪩</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: DARK, letterSpacing: '-0.03em' }}>Welcome back</div>
          <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>Sign in to your Disco Cater account</div>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: DARK, display: 'block', marginBottom: 5 }}>Email address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoFocus style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: F, color: DARK, boxSizing: 'border-box' }} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: DARK }}>Password</label>
              <a href="#" style={{ fontSize: 12, color: PURPLE, textDecoration: 'none' }}>Forgot password?</a>
            </div>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: F, color: DARK, boxSizing: 'border-box' }} onFocus={e => e.target.style.borderColor = PURPLE} onBlur={e => e.target.style.borderColor = '#e8e8e8'} />
          </div>
          {error && <div style={{ fontSize: 12, color: PINK, marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8, border: '1px solid #FFD0DC' }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: loading ? '#ccc' : DARK, border: 'none', borderRadius: 12, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: F, transition: 'background 0.15s' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: '#888' }}>
          Don&apos;t have an account? <a href="https://www.familymeal.com/registration" style={{ color: PURPLE, textDecoration: 'none', fontWeight: 600 }}>Create one</a>
        </div>
      </div>
    </div>
  )
}

// ── Portal Shell ───────────────────────────────────────────────────────────────
function Portal({ user, onSignOut }: { user: any; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('orders')
  const [menuOpen, setMenuOpen] = useState(false)

  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || 'DC'

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'orders', label: 'Orders', icon: '📦' },
    { id: 'subscriptions', label: 'Subscriptions', icon: '🔁' },
    { id: 'history', label: 'History', icon: '🕐' },
    { id: 'favorites', label: 'Favorites', icon: '❤️' },
  ]

  return (
    <div style={{ minHeight: '100svh', background: '#F8F8FC', fontFamily: F }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        @keyframes slideInRight { from { transform: translateX(100%) } to { transform: translateX(0) } }
        .portal-tab:hover { background: #F0F0FF !important; color: #6B6EF9 !important; }
        @media (max-width: 768px) {
          .portal-sidebar { display: none !important; }
          .portal-main { margin-left: 0 !important; padding: 16px !important; padding-bottom: 80px !important; }
          .portal-topnav { display: flex !important; }
          .portal-header { padding: 12px 16px !important; }
        }
        @media (min-width: 769px) {
          .portal-topnav { display: none !important; }
        }
      `}</style>

      {/* Top header */}
      <header className="portal-header" style={{ background: '#fff', borderBottom: '1.5px solid #f0f0f0', height: 56, display: 'flex', alignItems: 'center', padding: '0 24px', justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100 }}>
        <Link href="/">
          <img src="/disco-cater-logo.png" alt="Disco Cater" style={{ height: 30, objectFit: 'contain' }} />
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Mobile tab nav */}
          <div className="portal-topnav" style={{ display: 'none', gap: 4 }}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: '5px 10px', borderRadius: 8, border: 'none', background: tab === t.id ? '#F0F0FF' : 'transparent', color: tab === t.id ? PURPLE : '#888', fontSize: 12, fontWeight: tab === t.id ? 700 : 500, cursor: 'pointer', fontFamily: F }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Avatar */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMenuOpen(v => !v)} style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: GRADIENT, cursor: 'pointer', fontSize: 12, fontWeight: 800, color: '#fff', fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 10px rgba(107,110,249,0.3)' }}>
              {initials}
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 198 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 199, background: '#fff', border: '1.5px solid #eee', borderRadius: 14, padding: '8px 0', minWidth: 200, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
                  <div style={{ padding: '10px 16px 12px', borderBottom: '1px solid #f5f5f5', marginBottom: 4 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK, fontFamily: F }}>{user?.firstName} {user?.lastName}</div>
                    <div style={{ fontSize: 12, color: '#888', fontFamily: F, marginTop: 1 }}>{user?.email}</div>
                  </div>
                  {[
                    { label: 'Payment methods', tab: 'account' as Tab },
                    { label: 'Notifications', tab: 'account' as Tab },
                    { label: 'Account settings', tab: 'account' as Tab },
                  ].map(item => (
                    <button key={item.label} onClick={() => { setTab(item.tab); setMenuOpen(false) }} style={{ width: '100%', padding: '9px 16px', fontSize: 13, color: '#555', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: F }}>
                      {item.label}
                    </button>
                  ))}
                  <div style={{ borderTop: '1px solid #f5f5f5', marginTop: 4, paddingTop: 4 }}>
                    <button onClick={onSignOut} style={{ width: '100%', padding: '9px 16px', fontSize: 13, color: PINK, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: F }}>Sign out</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', minHeight: 'calc(100svh - 56px)' }}>
        {/* Sidebar */}
        <aside className="portal-sidebar" style={{ width: 220, background: '#fff', borderRight: '1.5px solid #f0f0f0', padding: '20px 10px', position: 'sticky', top: 56, height: 'calc(100svh - 56px)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#ccc', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: F, padding: '0 8px', marginBottom: 8 }}>My Account</div>
          {tabs.map(t => (
            <button key={t.id} className="portal-tab" onClick={() => setTab(t.id)} style={{ width: '100%', padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, borderRadius: 10, border: 'none', background: tab === t.id ? '#F0F0FF' : 'transparent', color: tab === t.id ? PURPLE : '#555', fontSize: 13, fontWeight: tab === t.id ? 700 : 500, cursor: 'pointer', fontFamily: F, marginBottom: 2, textAlign: 'left', transition: 'all 0.12s' }}>
              <span style={{ fontSize: 15 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
          <div style={{ height: 1, background: '#f0f0f0', margin: '12px 8px' }} />
          <button className="portal-tab" onClick={() => setTab('account')} style={{ width: '100%', padding: '9px 12px', display: 'flex', alignItems: 'center', gap: 10, borderRadius: 10, border: 'none', background: tab === 'account' ? '#F0F0FF' : 'transparent', color: tab === 'account' ? PURPLE : '#555', fontSize: 13, fontWeight: tab === 'account' ? 700 : 500, cursor: 'pointer', fontFamily: F, textAlign: 'left', transition: 'all 0.12s' }}>
            <span style={{ fontSize: 15 }}>👤</span>
            Account
          </button>
        </aside>

        {/* Main content */}
        <main className="portal-main" style={{ flex: 1, padding: '28px 32px', maxWidth: 780, overflowY: 'auto' }}>
          <div style={{ marginBottom: 20 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.03em', fontFamily: F }}>
              {tabs.find(t => t.id === tab)?.label ?? 'Account'}
            </h1>
            {tab === 'orders' && <p style={{ fontSize: 13, color: '#888', margin: 0, fontFamily: F }}>3 upcoming · 2 recurring</p>}
          </div>

          {tab === 'orders' && <OrdersTab />}
          {tab === 'subscriptions' && <SubscriptionsTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'favorites' && <FavoritesTab />}
          {tab === 'account' && <AccountTab onSignOut={onSignOut} />}
        </main>
      </div>
    </div>
  )
}

// ── Root ───────────────────────────────────────────────────────────────────────
export default function PortalPage() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const u = JSON.parse(stored)
        if (u?.token) setUser(u)
      }
    } catch {}
    setLoading(false)
  }, [])

  function handleSignOut() {
    localStorage.removeItem(STORAGE_KEY)
    window.location.href = '/'
  }

  if (loading) return (
    <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans', sans-serif", color: '#bbb', fontSize: 14 }}>
      Loading…
    </div>
  )

  if (!user) return <LoginScreen onLogin={u => setUser(u)} />
  return <Portal user={user} onSignOut={handleSignOut} />
}
