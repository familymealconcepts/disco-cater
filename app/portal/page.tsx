'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

const STORAGE_KEY = 'disco_user'

// ── Data ──────────────────────────────────────────────────────────────────────
const ORDERS = [
  { id: 0, name: 'Taim — Nolita', emoji: '🥙', people: 40, service: 'Delivery', paid: true, tag: 'rec', tagLabel: 'Weekly recurring', amt: 1240, date: 'May 6, 12:00 PM', status: 'active',
    items: [{ n: 'Team Lunch Box (x1)', p: '$28/pp' }, { n: 'Hummus & Pita Add-on', p: '$4/pp' }, { n: 'Beverages (x40)', p: '$3/pp' }],
    type: 'Recurring', orderDate: 'Every Tuesday', orderTime: '12:00 PM' },
  { id: 1, name: 'Son del Norte — LES', emoji: '🌮', people: 60, service: 'Delivery', paid: true, tag: 'cat', tagLabel: 'Event catering', amt: 2100, date: 'May 14, 11:30 AM', status: 'active',
    items: [{ n: 'Taco Bar Deluxe (x1)', p: '$30/pp' }, { n: 'Guac & Chips Station', p: '$5/pp' }],
    type: 'One-time', orderDate: 'May 14, 2026', orderTime: '11:30 AM' },
  { id: 2, name: 'Pecking House', emoji: '🥢', people: 25, service: 'Pickup', paid: false, tag: 'pau', tagLabel: 'Paused — payment failed', amt: 680, date: 'Paused', status: 'paused',
    items: [{ n: 'Office Feast (x1)', p: '$26/pp' }, { n: 'Spring Rolls (x25)', p: '$2/pp' }],
    type: 'Recurring', orderDate: 'Bi-weekly', orderTime: '12:30 PM' },
  { id: 0, name: 'Taim — Nolita', emoji: '🥙', people: 40, service: 'Delivery', paid: true, tag: 'rec', tagLabel: 'Weekly recurring', amt: 1240, date: 'May 13, 12:00 PM', status: 'active', items: [], type: 'Recurring', orderDate: 'Every Tuesday', orderTime: '12:00 PM' },
]
const PAST = [
  { id: 0, name: 'Taim — Nolita', emoji: '🥙', people: 40, service: 'Delivery', paid: true, amt: 1240, date: 'Apr 29, 2026' },
  { id: 1, name: 'Son del Norte — LES', emoji: '🌮', people: 55, service: 'Delivery', paid: true, amt: 1925, date: 'Apr 22, 2026' },
  { id: 0, name: 'Taim — Nolita', emoji: '🥙', people: 40, service: 'Delivery', paid: true, amt: 1240, date: 'Apr 15, 2026' },
  { id: 2, name: 'Pecking House', emoji: '🥢', people: 25, service: 'Pickup', paid: true, amt: 680, date: 'Apr 8, 2026' },
]
const FAVS_INIT = [
  { id: 'f0', name: 'Taim — Nolita', emoji: '🥙' },
  { id: 'f1', name: 'Son del Norte — LES', emoji: '🌮' },
  { id: 'f2', name: 'Pecking House', emoji: '🥢' },
  { id: 'f3', name: '5ive Spice LES', emoji: '🌶️' },
  { id: 'f4', name: 'Melt Shop', emoji: '🥪' },
]
const CAL_EVS: Record<number, { l: string; t: 'rec' | 'cat' | 'pau'; i: number }[]> = {
  6: [{ l: 'Taim', t: 'rec', i: 0 }], 12: [{ l: 'Taim', t: 'rec', i: 0 }],
  13: [{ l: 'Son del Norte', t: 'cat', i: 1 }], 14: [{ l: 'Son del Norte', t: 'cat', i: 1 }],
  19: [{ l: 'Taim', t: 'rec', i: 0 }], 20: [{ l: 'Pecking House', t: 'pau', i: 2 }],
  26: [{ l: 'Taim', t: 'rec', i: 0 }], 27: [{ l: 'Team offsite', t: 'cat', i: 1 }],
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// ── SVG Icons (exact from original) ──────────────────────────────────────────
const IconOrders = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
const IconSubs = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
const IconHistory = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
const IconFavs = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
const IconCard = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
const IconBell = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
const IconUser = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
const IconSignOut = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
const IconCheck = () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
const IconCardLg = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>

// ── Tag component ─────────────────────────────────────────────────────────────
function Tag({ t, label }: { t: string; label: string }) {
  const styles: Record<string, React.CSSProperties> = {
    rec: { background: '#EEEDFE', color: '#3C3489' },
    cat: { background: '#E1F5EE', color: '#085041' },
    pau: { background: '#FAEEDA', color: '#633806' },
  }
  return <span style={{ display: 'inline-block', fontSize: 9, padding: '2px 7px', borderRadius: 20, fontWeight: 700, marginTop: 5, ...styles[t] }}>{label}</span>
}

// ── Right Panel ───────────────────────────────────────────────────────────────
function RightPanel({ idx, onClose, onPayment }: { idx: number; onClose: () => void; onPayment: () => void }) {
  const o = ORDERS[idx] || ORDERS[0]
  const isPaused = o.tag === 'pau'
  return (
    <div style={{ width: 252, minWidth: 252, borderLeft: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fff', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{o.name}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#777', fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
      </div>
      <div style={{ margin: '10px 10px 0', border: '1px solid #ebebeb', borderRadius: 10, padding: 11 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111', marginBottom: 1 }}>{o.name}</div>
        <div style={{ fontSize: 10, color: '#555' }}>{o.people} people</div>
        <Tag t={o.tag} label={o.tagLabel} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '0.5px solid #f0f0f0' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>${o.amt.toLocaleString()}</span>
          <span style={{ fontSize: 10, color: isPaused ? '#BA7517' : '#111', fontWeight: 600 }}>{o.date}</span>
        </div>
      </div>
      <div style={{ margin: '8px 10px 10px', background: '#f5f5f5', borderRadius: 8, padding: 10 }}>
        {o.items && o.items.length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#777', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Items</div>
            {o.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '1px 0' }}>
                <span style={{ color: '#333', fontWeight: 500 }}>{item.n}</span>
                <span style={{ color: '#555' }}>{item.p}</span>
              </div>
            ))}
            <div style={{ height: '0.5px', background: '#e8e8e8', margin: '5px 0' }} />
          </>
        )}
        {[['Type', o.type], ['Service', o.service], ['Order date', o.orderDate], ['Order time', o.orderTime], ['Payment', o.paid ? 'Paid' : 'Unpaid']].map(([l, v]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0' }}>
            <span style={{ color: '#777' }}>{l}</span>
            <span style={{ color: l === 'Payment' ? (o.paid ? '#1D9E75' : '#E24B4A') : '#111', fontWeight: 600 }}>{v}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
          {isPaused ? (
            <button onClick={onPayment} style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Update card</button>
          ) : o.type === 'One-time' ? (
            <>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Edit</button>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '0.5px solid #F09595', color: '#E24B4A', fontFamily: "'DM Sans',sans-serif" }}>Cancel</button>
            </>
          ) : (
            <>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Edit</button>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '0.5px solid #e0e0e0', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>Skip next</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function Calendar({ onOpenRP }: { onOpenRP: (i: number) => void }) {
  const [yr, setYr] = useState(2026)
  const [mo, setMo] = useState(4)
  const now = new Date()
  const first = new Date(yr, mo, 1).getDay()
  const days = new Date(yr, mo + 1, 0).getDate()
  const prev = new Date(yr, mo, 0).getDate()
  const cells: { d: number; cur: boolean; today: boolean }[] = []
  for (let i = 0; i < first; i++) cells.push({ d: prev - first + 1 + i, cur: false, today: false })
  for (let d = 1; d <= days; d++) cells.push({ d, cur: true, today: now.getFullYear() === yr && now.getMonth() === mo && now.getDate() === d })
  const rem = (first + days) % 7
  for (let i = 1; i <= (rem ? 7 - rem : 0); i++) cells.push({ d: i, cur: false, today: false })
  const chM = (dir: number) => { let m = mo + dir, y = yr; if (m > 11) { m = 0; y++ } if (m < 0) { m = 11; y-- } setMo(m); setYr(y) }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{MONTHS[mo]} {yr}</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginLeft: 14 }}>
            {[{ c: '#6B6EF9', l: 'Recurring' }, { c: '#1D9E75', l: 'Catering' }, { c: '#BA7517', l: 'Paused' }].map(x => (
              <div key={x.l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: x.c, flexShrink: 0 }} />
                <span style={{ fontSize: 10, color: '#555' }}>{x.l}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => chM(-1)} style={{ background: '#f0f0f0', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>‹</button>
          <button onClick={() => chM(1)} style={{ background: '#f0f0f0', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 13, cursor: 'pointer', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>›</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', border: '1px solid #e8e8e8', borderRadius: 10, overflow: 'hidden' }}>
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} style={{ background: '#f5f5f5', textAlign: 'center', fontSize: 9, color: '#777', padding: '7px 2px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid #f0f0f0' }}>{d}</div>
        ))}
        {cells.map((cell, i) => {
          const evs = cell.cur ? (CAL_EVS[cell.d] || []) : []
          return (
            <div key={i} onClick={() => evs.length && onOpenRP(evs[0].i)} style={{ background: cell.today ? '#f0f0ff' : '#fff', minHeight: 72, padding: 6, cursor: evs.length ? 'pointer' : 'default', borderRight: '0.5px solid #f5f5f5', borderBottom: '0.5px solid #f5f5f5', opacity: cell.cur ? 1 : 0.3, transition: 'background 0.1s' }}
              onMouseOver={e => { if (evs.length) (e.currentTarget as HTMLElement).style.background = '#fafafa' }}
              onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = cell.today ? '#f0f0ff' : '#fff' }}
            >
              <div style={{ fontSize: 10, fontWeight: cell.today ? 700 : 600, color: cell.today ? '#6B6EF9' : '#888', marginBottom: 3 }}>{cell.d}</div>
              {evs.map((ev, j) => {
                const s: Record<string, React.CSSProperties> = {
                  rec: { background: '#EEEDFE', color: '#3C3489' },
                  cat: { background: '#E1F5EE', color: '#085041' },
                  pau: { background: '#FAEEDA', color: '#633806' },
                }
                return <div key={j} onClick={e => { e.stopPropagation(); onOpenRP(ev.i) }} style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, cursor: 'pointer', ...s[ev.t] }}>{ev.l}</div>
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Order list row ────────────────────────────────────────────────────────────
function OLR({ o, onClick }: { o: any; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', padding: '11px 10px', borderBottom: '1px solid #f5f5f5', gap: 12, cursor: 'pointer', borderRadius: 8, transition: 'background 0.1s' }}
      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
      onMouseOut={e => (e.currentTarget as HTMLElement).style.background = ''}
    >
      <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>{o.emoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{o.name}</div>
        <div style={{ fontSize: 10, color: '#555', marginTop: 1 }}>{o.people} people · {o.service} · <span style={{ color: o.paid ? '#1D9E75' : '#E24B4A', fontWeight: 600 }}>{o.paid ? 'Paid' : 'Unpaid'}</span></div>
        {o.tagLabel && <div style={{ marginTop: 3 }}><Tag t={o.tag} label={o.tagLabel} /></div>}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>${o.amt.toLocaleString()}</div>
        <div style={{ fontSize: 10, color: o.tag === 'pau' ? '#BA7517' : '#111', fontWeight: 600, marginTop: 2 }}>{o.date}</div>
      </div>
    </div>
  )
}

// ── Discover CTA ──────────────────────────────────────────────────────────────
function DiscoverCTA() {
  return (
    <Link href="/fullmap" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, padding: '12px 14px', border: '1px dashed #c8cafd', borderRadius: 10, cursor: 'pointer', background: 'linear-gradient(135deg,rgba(107,110,249,0.04),rgba(192,68,200,0.04))', textDecoration: 'none' }}>
      <span style={{ fontSize: 22, flexShrink: 0 }}>🪩</span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#6B6EF9' }}>Discover more restaurants</div>
        <div style={{ fontSize: 10, color: '#aaa', marginTop: 1 }}>Find new catering options on Disco Cater</div>
      </div>
      <span style={{ marginLeft: 'auto', fontSize: 14, color: '#6B6EF9' }}>→</span>
    </Link>
  )
}

// ── Main Portal ───────────────────────────────────────────────────────────────
function Portal({ user, onSignOut }: { user: any; onSignOut: () => void }) {
  type Page = 'orders' | 'subscriptions' | 'history' | 'favorites' | 'account' | 'notifs' | 'payment' | 'confirm' | 'success' | 'payfail'
  const [page, setPage] = useState<Page>('orders')
  const [view, setView] = useState<'cal' | 'list'>('cal')
  const [rpIdx, setRpIdx] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [favs, setFavs] = useState(FAVS_INIT)
  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || 'DC'

  const openRP = (i: number) => setRpIdx(i)
  const closeRP = () => setRpIdx(null)

  const pageConfig: Record<string, { title: string; sub: string; showTog: boolean; showNew: boolean }> = {
    orders: { title: 'Orders', sub: '3 upcoming · 2 recurring', showTog: true, showNew: true },
    subscriptions: { title: 'Subscriptions', sub: '2 active subscriptions', showTog: false, showNew: false },
    history: { title: 'History', sub: 'All past orders', showTog: false, showNew: false },
    favorites: { title: 'Favorites', sub: 'Your saved restaurants', showTog: false, showNew: false },
    account: { title: 'Account settings', sub: 'Manage your profile', showTog: false, showNew: false },
    notifs: { title: 'Notifications', sub: '', showTog: false, showNew: false },
    payment: { title: 'Payment methods', sub: 'Manage saved cards', showTog: false, showNew: false },
    confirm: { title: 'Orders', sub: '3 upcoming · 2 recurring', showTog: false, showNew: false },
    success: { title: 'Orders', sub: '3 upcoming · 2 recurring', showTog: false, showNew: false },
    payfail: { title: 'Payment failed', sub: '', showTog: false, showNew: false },
  }
  const cfg = pageConfig[page] || pageConfig.orders

  const sideItems = [
    { id: 'orders', icon: <IconOrders />, tip: 'Orders', dot: true },
    { id: 'subscriptions', icon: <IconSubs />, tip: 'Subscriptions', dot: true },
    { id: 'history', icon: <IconHistory />, tip: 'History', dot: false },
    { id: 'favorites', icon: <IconFavs />, tip: 'Favorites', dot: false },
  ]

  return (
    <div style={{ width: '100%', minHeight: '100svh', display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .si-tip { position:absolute;left:50px;top:50%;transform:translateY(-50%);background:#1A1028;color:#fff;font-size:11px;font-weight:600;padding:4px 9px;border-radius:7px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity 0.15s;z-index:300; }
        .si-tip::before { content:'';position:absolute;right:100%;top:50%;transform:translateY(-50%);border:5px solid transparent;border-right-color:#1A1028; }
        .si-btn:hover .si-tip { opacity:1; }
        .si-btn:hover { background:#efefef !important; }
        .olr-row:hover { background:#fafafa; }
        .fav-x-btn { display:none !important; }
        .fav-card-wrap:hover .fav-x-btn { display:flex !important; }
        .cal-cell-hover:hover { background:#fafafa; }
      `}</style>

      {/* Top nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff', flexShrink: 0 }}>
        <Link href='/' style={{ textDecoration: 'none' }}><span style={{ fontSize: 15, fontWeight: 700, background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', letterSpacing: '-0.3px', marginRight: 4 }}>disco cater</span></Link>
        <div style={{ width: 1, height: 18, background: '#e8e8e8', flexShrink: 0 }} />
        {(['orders','subscriptions','history','favorites'] as const).map(p => (
          <button key={p} onClick={() => { setPage(p); closeRP() }} style={{ padding: '4px 12px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap', transition: 'all 0.12s', background: page === p ? '#1A1028' : '#efefef', color: page === p ? '#fff' : '#555' }}>
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
          <Link href="/fullmap" style={{ fontSize: 13, fontWeight: 500, color: '#555', textDecoration: 'none', fontFamily: "'DM Sans',sans-serif" }}>Catering Map</Link>
          <Link href="/faq" style={{ fontSize: 13, fontWeight: 500, color: '#555', textDecoration: 'none', fontFamily: "'DM Sans',sans-serif" }}>FAQ</Link>
          <div style={{ position: 'relative' }}>
          <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#fff', background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif" }}>
            {initials}
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 399 }} />
              <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#fff', border: '1px solid #e8e8e8', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.12)', minWidth: 210, zIndex: 400, overflow: 'hidden' }}>
                <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #f0f0f0' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{user?.firstName} {user?.lastName}</div>
                  <div style={{ fontSize: 10, color: '#777', marginTop: 1 }}>{user?.email}</div>
                </div>
                <div style={{ padding: '5px 0' }}>
                  {[
                    { icon: <IconCard />, label: 'Payment methods', action: () => { setPage('payment'); setMenuOpen(false); closeRP() } },
                    { icon: <IconBell />, label: 'Notifications', badge: '1', action: () => { setPage('notifs'); setMenuOpen(false); closeRP() } },
                    { icon: <IconUser />, label: 'Account settings', action: () => { setPage('account'); setMenuOpen(false); closeRP() } },
                  ].map(item => (
                    <button key={item.label} onClick={item.action} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#444', fontWeight: 500, transition: 'background 0.1s', border: 'none', background: 'transparent', width: '100%', fontFamily: "'DM Sans',sans-serif", textAlign: 'left' }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#e8e8e8'}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                    >
                      <span style={{ color: '#999', flexShrink: 0 }}>{item.icon}</span>
                      {item.label}
                      {item.badge && <span style={{ marginLeft: 'auto', background: '#EFB84A', color: '#5A3800', fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 10 }}>{item.badge}</span>}
                    </button>
                  ))}
                </div>
                <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
                <div style={{ padding: '5px 0' }}>
                  <button onClick={onSignOut} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#E24B4A', fontWeight: 500, border: 'none', background: 'transparent', width: '100%', fontFamily: "'DM Sans',sans-serif", textAlign: 'left' }}
                    onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#e8e8e8'}
                    onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <span style={{ color: '#E24B4A', flexShrink: 0 }}><IconSignOut /></span>
                    Sign out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', minHeight: 640 }}>
        {/* Icon sidebar */}
        <div style={{ width: 56, minWidth: 56, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#f5f5f5', padding: '12px 0 16px', gap: 4 }}>
          {sideItems.map(item => (
            <button key={item.id} className="si-btn" onClick={() => { setPage(item.id as Page); closeRP() }} style={{ position: 'relative', width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: 'none', background: page === item.id ? 'rgba(107,110,249,0.1)' : 'transparent', color: page === item.id ? '#6B6EF9' : '#888', transition: 'background 0.12s' }}>
              {item.icon}
              <span className="si-tip">{item.tip}</span>
              {item.dot && <span style={{ position: 'absolute', top: 5, right: 5, width: 7, height: 7, background: '#6B6EF9', borderRadius: '50%', border: '1.5px solid #fafafa' }} />}
            </button>
          ))}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>{cfg.title}</div>
              {cfg.sub && <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>{cfg.sub}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {cfg.showTog && (
                <div style={{ display: 'flex', background: '#f0f0f0', borderRadius: 8, padding: 2, gap: 2 }}>
                  {(['list', 'cal'] as const).map(v => (
                    <button key={v} onClick={() => setView(v)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: view === v ? '0.5px solid #e0e0e0' : 'none', background: view === v ? '#fff' : 'transparent', color: view === v ? '#111' : '#888', fontFamily: "'DM Sans',sans-serif" }}>
                      {v === 'list' ? 'List' : 'Calendar'}
                    </button>
                  ))}
                </div>
              )}
              {cfg.showNew && (
                <button onClick={() => setPage('favorites')} style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>+ New order</button>
              )}
            </div>
          </div>

          <div style={{ flex: 1, padding: '18px 20px', overflowY: 'auto' }}>
            {/* Orders - Calendar */}
            {page === 'orders' && view === 'cal' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 18 }}>
                  {[{ l: 'Active orders', v: '3', s: '2 recurring · 1 one-time' }, { l: 'Total orders placed', v: '47', s: 'since Jan 2025' }, { l: 'Next order', v: 'May 6', s: 'Taim — Nolita · 12:00 PM', small: true }].map(s => (
                    <div key={s.l} style={{ background: '#f5f5f5', borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 10, color: '#777', marginBottom: 4, fontWeight: 600 }}>{s.l}</div>
                      <div style={{ fontSize: s.small ? 16 : 22, fontWeight: 700, color: '#111', paddingTop: s.small ? 3 : 0 }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>{s.s}</div>
                    </div>
                  ))}
                </div>
                <Calendar onOpenRP={openRP} />
              </div>
            )}

            {/* Orders - List */}
            {page === 'orders' && view === 'list' && (
              <div>
                <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 2px', marginBottom: 8 }}>Upcoming</div>
                {ORDERS.map((o, i) => <OLR key={i} o={o} onClick={() => openRP(o.id)} />)}
                <div onClick={() => setShowPast(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 10, cursor: 'pointer', borderRadius: 8, marginTop: 8, background: '#f5f5f5', border: '1px solid #f0f0f0' }}
                  onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f0f0f0'}
                  onMouseOut={e => (e.currentTarget as HTMLElement).style.background = '#fafafa'}
                >
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#555' }}>Past orders (12)</span>
                  <span style={{ fontSize: 11, color: '#777', transition: 'transform 0.2s', transform: showPast ? 'rotate(180deg)' : 'none' }}>▾</span>
                </div>
                {showPast && (
                  <div style={{ overflow: 'hidden' }}>
                    {PAST.map((o, i) => <OLR key={i} o={{ ...o, tag: '', tagLabel: '' }} onClick={() => openRP(o.id)} />)}
                  </div>
                )}
                <DiscoverCTA />
              </div>
            )}

            {/* Confirm */}
            {page === 'confirm' && (
              <div style={{ maxWidth: 400 }}>
                <div style={{ background: '#f5f5f5', borderRadius: 10, padding: 14, marginBottom: 14, border: '1px solid #ebebeb' }}>
                  <div style={{ fontSize: 10, color: '#777', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order summary</div>
                  <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                    {[['Restaurant','Taim — Nolita'],['Items','Team Lunch Box'],['Headcount','30 people'],['Type','Recurring — weekly'],['Service','Delivery'],['Order date','Every Tuesday'],['Order time','12:00 PM'],['Est. per order','$840']].map(([l,v],i) => (
                      <tr key={i}><td style={{ padding: '3px 0', borderTop: i === 7 ? '1px solid #f0f0f0' : 'none', paddingTop: i === 7 ? 7 : 3, fontWeight: i === 7 ? 700 : 400, color: i === 7 ? '#111' : '#bbb' }}>{l}</td><td style={{ textAlign: 'right', fontWeight: i === 7 ? 700 : 600, color: i === 7 ? '#5B6FE8' : '#111', fontSize: i === 7 ? 15 : 11 }}>{v}</td></tr>
                    ))}
                  </table>
                </div>
                <div style={{ background: '#E1F5EE', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: '#085041', marginBottom: 14, lineHeight: 1.6 }}>A confirmation email will be sent 24 hours before each order. You can skip or cancel anytime.</div>
                <div style={{ fontSize: 11, color: '#777', marginBottom: 14 }}>Payment: <span style={{ color: '#111', fontWeight: 600 }}>Visa ···4821</span> &nbsp;·&nbsp; <span style={{ color: '#6B6EF9', cursor: 'pointer', fontWeight: 600 }}>Change</span></div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={() => setPage('favorites')} style={{ flex: 1, padding: 9, borderRadius: 7, border: '1px solid #e0e0e0', background: '#fff', color: '#555', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>← Back</button>
                  <button onClick={() => setPage('success')} style={{ flex: 2, padding: 9, borderRadius: 7, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Place order</button>
                </div>
              </div>
            )}

            {/* Success */}
            {page === 'success' && (
              <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#E1F5EE', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px' }}><IconCheck /></div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 10 }}>Order confirmed!</div>
                <div style={{ fontSize: 13, color: '#555', lineHeight: 1.8, marginBottom: 28 }}>Your recurring order with <strong>Taim — Nolita</strong><br />is set for every Tuesday at 12:00 PM.<br />First order: May 6, 2026.</div>
                <button onClick={() => setPage('orders')} style={{ background: '#5B6FE8', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Back to orders</button>
              </div>
            )}

            {/* Payment failed */}
            {page === 'payfail' && (
              <div style={{ maxWidth: 400 }}>
                <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: '#633806', marginBottom: 14, lineHeight: 1.6 }}><strong>Payment failed for Pecking House.</strong> Your order has been paused. Update your card to resume.</div>
                <div style={{ marginBottom: 12 }}><span style={{ fontSize: 10, color: '#777', display: 'block', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Card number</span><input type="text" placeholder="1234 5678 9012 3456" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#f5f5f5', fontFamily: "'DM Sans',sans-serif", outline: 'none' }} /></div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  {['Expiry','CVC'].map(l => <div key={l} style={{ flex: 1 }}><span style={{ fontSize: 10, color: '#777', display: 'block', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{l}</span><input type="text" placeholder={l === 'Expiry' ? 'MM / YY' : '123'} style={{ width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#f5f5f5', fontFamily: "'DM Sans',sans-serif", outline: 'none' }} /></div>)}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setPage('orders')} style={{ flex: 1, padding: 9, borderRadius: 7, border: '1px solid #e0e0e0', background: '#fff', color: '#555', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Cancel</button>
                  <button onClick={() => setPage('orders')} style={{ flex: 2, padding: 9, borderRadius: 7, border: 'none', background: '#5B6FE8', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Update &amp; resume</button>
                </div>
              </div>
            )}

            {/* History */}
            {page === 'history' && (
              <div>
                <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 2px', marginBottom: 8 }}>All past orders</div>
                {[...ORDERS, ...PAST].map((o, i) => <OLR key={i} o={{ ...(o as any), tag: (o as any).tag || '', tagLabel: '' }} onClick={() => openRP(Math.min((o as any).id || 0, 2))} />)}
                <DiscoverCTA />
              </div>
            )}

            {/* Favorites */}
            {page === 'favorites' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12 }}>
                {favs.map(f => (
                  <div key={f.id} className="fav-card-wrap" style={{ border: '1px solid #ebebeb', borderRadius: 12, overflow: 'visible', position: 'relative', transition: 'border-color 0.12s,box-shadow 0.12s' }}
                    onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c0c0c0'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.07)' }}
                    onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#ebebeb'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                  >
                    <button className="fav-x-btn" onClick={() => setFavs(p => p.filter(x => x.id !== f.id))} style={{ position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%', background: '#fff', border: '1px solid #e0e0e0', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#555', cursor: 'pointer', zIndex: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.1)', display: 'none' }}>✕</button>
                    <div style={{ width: '100%', height: 86, background: '#f5f1eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, borderRadius: '11px 11px 0 0' }}>{f.emoji}</div>
                    <div style={{ padding: '9px 11px 11px' }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#111', marginBottom: 6 }}>{f.name}</div>
                      <button onClick={() => setPage('confirm')} style={{ display: 'block', textAlign: 'center', padding: 6, background: '#5B6FE8', color: '#fff', border: 'none', borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", width: '100%' }}>Order catering</button>
                    </div>
                  </div>
                ))}
                <div onClick={() => window.open('/fullmap', '_blank')} style={{ border: '1px dashed #c8cafd', borderRadius: 12, cursor: 'pointer', transition: 'all 0.12s', background: 'linear-gradient(135deg,rgba(107,110,249,0.03),rgba(192,68,200,0.03))' }}
                  onMouseOver={e => { (e.currentTarget as HTMLElement).style.borderColor = '#6B6EF9'; (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(107,110,249,0.12)' }}
                  onMouseOut={e => { (e.currentTarget as HTMLElement).style.borderColor = '#c8cafd'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
                >
                  <div style={{ width: '100%', height: 86, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, borderRadius: '11px 11px 0 0' }}>🪩</div>
                  <div style={{ padding: '9px 11px 11px', textAlign: 'center' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6B6EF9', marginBottom: 6 }}>Discover more options</div>
                    <button style={{ display: 'block', textAlign: 'center', padding: 6, background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", width: '100%' }}>Browse Disco Cater</button>
                  </div>
                </div>
              </div>
            )}

            {/* Subscriptions */}
            {page === 'subscriptions' && (
              <div>
                {[
                  { emoji: '🥙', name: 'Taim — Nolita', people: 40, svc: 'Delivery', freq: 'Every Tuesday · 12:00 PM', freqColor: '#6B6EF9', amt: 1240, next: 'May 6', status: 'a' },
                  { emoji: '🥢', name: 'Pecking House', people: 25, svc: 'Pickup', freq: 'Bi-weekly · Paused — payment failed', freqColor: '#BA7517', amt: 680, next: 'Paused', status: 'p' },
                ].map(s => (
                  <div key={s.name} style={{ border: `1px solid #ebebeb`, borderLeft: `3px solid ${s.status === 'a' ? '#6B6EF9' : '#BA7517'}`, borderRadius: 12, padding: 14, marginBottom: 10, display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ width: 38, height: 38, borderRadius: 8, background: '#EEEDFE', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>{s.emoji}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{s.people} people · {s.svc}</div>
                      <div style={{ fontSize: 10, color: s.freqColor, fontWeight: 600, marginTop: 3 }}>{s.freq}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                        {s.status === 'a' ? (
                          <>
                            <button style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Edit</button>
                            <button style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', background: 'transparent', border: '0.5px solid #e0e0e0', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>Skip next</button>
                          </>
                        ) : (
                          <button onClick={() => setPage('payfail')} style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', background: '#1D9E75', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Update card</button>
                        )}
                        <button style={{ padding: '5px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: 'pointer', background: 'transparent', border: '0.5px solid #F09595', color: '#E24B4A', fontFamily: "'DM Sans',sans-serif" }}>Cancel subscription</button>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>${s.amt.toLocaleString()}</div>
                      <div style={{ fontSize: 10, color: s.status === 'p' ? '#BA7517' : '#111', fontWeight: 600, marginTop: 2 }}>Next: {s.next}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Account */}
            {page === 'account' && <AccountForm user={user} />}

            {/* Notifications */}
            {page === 'notifs' && (
              <div>
                <div style={{ padding: '8px 2px 14px', fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notifications</div>
                <div style={{ border: '1px solid #EFB84A', background: '#FEF9EC', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <IconBell />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>Payment failed — Pecking House</div>
                    <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>Your bi-weekly order has been paused. Update your card to resume.</div>
                  </div>
                </div>
              </div>
            )}

            {/* Payment methods */}
            {page === 'payment' && (
              <div>
                <div style={{ padding: '8px 2px 14px', fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment methods</div>
                <div style={{ border: '1px solid #ebebeb', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <IconCardLg />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>No payment method on file</div>
                      <div style={{ fontSize: 10, color: '#777', marginTop: 1 }}>Add a card to place orders</div>
                    </div>
                  </div>
                </div>
                <button style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>+ Add payment method</button>
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        {rpIdx !== null && <RightPanel idx={rpIdx} onClose={closeRP} onPayment={() => { closeRP(); setPage('payfail') }} />}
      </div>
    </div>
  )
}

// ── Account Form ──────────────────────────────────────────────────────────────
function AccountForm({ user }: { user: any }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [saved, setSaved] = useState(false)

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

  const fi: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#f5f5f5', fontFamily: "'DM Sans',sans-serif", outline: 'none' }
  const fl: React.CSSProperties = { fontSize: 10, color: '#777', marginBottom: 3, display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }

  async function save() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (!stored) return
      const u = JSON.parse(stored)
      await fetch('/api/fm-user', { method: 'PUT', headers: { 'Authorization': `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName, lastName, email, phoneNumber: phone }) })
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...u, firstName, lastName, email, phoneNumber: phone }))
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch {}
  }

  return (
    <div style={{ maxWidth: 440 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Personal info</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><span style={fl}>First name</span><input style={fi} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
        <div><span style={fl}>Last name</span><input style={fi} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
      </div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Email address</span><input style={fi} type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Phone number</span><input style={fi} type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></div>
      <div style={{ height: 1, background: '#f0f0f0', margin: '20px 0' }} />
      <div style={{ fontSize: 11, fontWeight: 700, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Addresses</div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Home address</span><input style={fi} placeholder="Add address" /></div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Work address</span><input style={fi} placeholder="Add address" /></div>
      <div style={{ height: 1, background: '#f0f0f0', margin: '20px 0' }} />
      <div style={{ fontSize: 11, fontWeight: 700, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Security</div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Current password</span><input style={fi} type="password" placeholder="••••••••" /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><span style={fl}>New password</span><input style={fi} type="password" placeholder="••••••••" /></div>
        <div><span style={fl}>Confirm password</span><input style={fi} type="password" placeholder="••••••••" /></div>
      </div>
      <button onClick={save} style={{ background: saved ? '#1D9E75' : '#5B6FE8', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", marginBottom: 20, transition: 'background 0.2s' }}>
        {saved ? '✓ Saved' : 'Save changes'}
      </button>
      <div style={{ height: 1, background: '#f0f0f0', margin: '0 0 20px' }} />
      <div style={{ fontSize: 11, fontWeight: 700, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Danger zone</div>
      <div style={{ border: '1px solid #F09595', borderRadius: 10, padding: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#E24B4A', marginBottom: 6 }}>Delete account</div>
        <div style={{ fontSize: 11, color: '#555', marginBottom: 10, lineHeight: 1.6 }}>Permanently delete your Disco Cater account and all associated order history. This action cannot be undone.</div>
        <button style={{ background: 'transparent', border: '1px solid #E24B4A', color: '#E24B4A', borderRadius: 7, padding: '7px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif" }}>Delete my account</button>
      </div>
    </div>
  )
}

// ── Login ─────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: (u: any) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Please enter your email and password.'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/fm-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Invalid email or password.'); setLoading(false); return }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      onLogin(data)
    } catch { setError('Something went wrong.') }
    finally { setLoading(false) }
  }

  return (
    <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F8F8FC', fontFamily: "'DM Sans',sans-serif", padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 400, padding: 36, boxShadow: '0 8px 40px rgba(107,110,249,0.10)' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>🪩</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#1A1028', letterSpacing: '-0.03em' }}>Welcome back</div>
          <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>Sign in to your Disco Cater account</div>
        </div>
        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#1A1028', display: 'block', marginBottom: 5 }}>Email address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoFocus style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: "'DM Sans',sans-serif", color: '#1A1028', boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#1A1028' }}>Password</label>
              <a href="#" style={{ fontSize: 12, color: '#6B6EF9', textDecoration: 'none' }}>Forgot password?</a>
            </div>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', padding: '11px 14px', fontSize: 14, border: '1.5px solid #e8e8e8', borderRadius: 10, outline: 'none', fontFamily: "'DM Sans',sans-serif", color: '#1A1028', boxSizing: 'border-box' }} />
          </div>
          {error && <div style={{ fontSize: 12, color: '#F0468A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', padding: 13, fontSize: 14, fontWeight: 700, color: '#fff', background: loading ? '#ccc' : '#1A1028', border: 'none', borderRadius: 12, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans',sans-serif" }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: '#555' }}>
          Don&apos;t have an account? <a href="https://www.familymeal.com/registration" style={{ color: '#6B6EF9', textDecoration: 'none', fontWeight: 600 }}>Create one</a>
        </div>
      </div>
    </div>
  )
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function PortalPage() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY)
      if (s) { const u = JSON.parse(s); if (u?.token) setUser(u) }
    } catch {}
    setLoading(false)
  }, [])

  if (loading) return <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif", color: '#777' }}>Loading…</div>

  if (!user) return <LoginScreen onLogin={u => setUser(u)} />

  return (
    <Portal user={user} onSignOut={() => { localStorage.removeItem(STORAGE_KEY); window.location.href = '/' }} />
  )
}
