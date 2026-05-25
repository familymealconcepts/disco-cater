'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAuthContext } from '../context/AuthContext'

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
function RightPanel({ order, onClose, onPayment }: { order: any; onClose: () => void; onPayment: () => void }) {
  const o = order || {}
  const isPaused = o.tag === 'pau' || o.status === 'PAUSED'
  const name = o.name || o.restaurantName || o.restaurant?.name || 'Order'
  const amt = o.amt || o.total || o.totalAmount || 0
  const date = o.date || o.orderDate || o.deliveryDate || '—'
  const items = o.items || []
  const orderType = o.type || o.orderType || '—'
  const service = o.service || o.orderType || '—'
  const isPaid = o.paid !== undefined ? o.paid : (o.status !== 'UNPAID')
  const tag = o.tag || (isPaused ? 'pau' : 'cat')
  const tagLabel = o.tagLabel || o.status || '—'
  return (
    <div className="rp" style={{ width: 252, minWidth: 252, borderLeft: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fff', overflowY: 'auto' }}>
      <div className="rp-handle" style={{ display: 'none' }}><div style={{ width: 36, height: 4, borderRadius: 2, background: '#ddd', margin: '10px auto 4px' }} /></div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #f0f0f0' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>{name}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
      </div>
      <div style={{ margin: '10px 10px 0', border: '1px solid #ebebeb', borderRadius: 10, padding: 11 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#111', marginBottom: 1 }}>{name}</div>
        {o.people && <div style={{ fontSize: 10, color: '#555' }}>{o.people} people</div>}
        {tagLabel && <Tag t={tag} label={tagLabel} />}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '0.5px solid #f0f0f0' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>${amt.toLocaleString ? amt.toLocaleString() : amt}</span>
          <span style={{ fontSize: 10, color: isPaused ? '#BA7517' : '#111', fontWeight: 600 }}>{date}</span>
        </div>
      </div>
      <div style={{ margin: '8px 10px 10px', background: '#efefef', borderRadius: 8, padding: 10 }}>
        {items.length > 0 && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Items</div>
            {items.map((item: any, i: number) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '1px 0' }}>
                <span style={{ color: '#333', fontWeight: 500 }}>{item.n || item.name || item.mealPackageName}</span>
                <span style={{ color: '#555' }}>{item.p || item.price}</span>
              </div>
            ))}
            <div style={{ height: '0.5px', background: '#e8e8e8', margin: '5px 0' }} />
          </>
        )}
        {[['Type', orderType], ['Service', service], ['Payment', isPaid ? 'Paid' : 'Unpaid']].map(([l, v]) => (
          <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0' }}>
            <span style={{ color: '#666' }}>{l}</span>
            <span style={{ color: l === 'Payment' ? (isPaid ? '#1D9E75' : '#E24B4A') : '#111', fontWeight: 600 }}>{v}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 5, marginTop: 8 }}>
          {isPaused ? (
            <button onClick={onPayment} style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Update card</button>
          ) : (
            <>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: '#5B6FE8', color: '#fff', border: 'none', fontFamily: "'DM Sans',sans-serif" }}>Edit</button>
              <button style={{ flex: 1, padding: 6, borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', background: 'transparent', border: '0.5px solid #F09595', color: '#E24B4A', fontFamily: "'DM Sans',sans-serif" }}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function Calendar({ orders, onOpenRP }: { orders: any[]; onOpenRP: (i: number) => void }) {
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
  const chM = (dir: number) => { let m = mo + dir, y = yr; if (m > 11) { m = 0; y++ } if (m < 0) { m = 11; y-- } setMo(m); setYr(y) }

  // Build calendar events from real orders
  const calEvs: Record<number, { l: string; t: string; i: number }[]> = {}
  orders.forEach((o, idx) => {
    const dateStr = o.orderDate || o.deliveryDate || o.date || o.createdAt || ''
    if (!dateStr) return
    try {
      const d = new Date(dateStr)
      if (d.getFullYear() === yr && d.getMonth() === mo) {
        const day = d.getDate()
        if (!calEvs[day]) calEvs[day] = []
        calEvs[day].push({ l: o.restaurantName || o.restaurant?.name || 'Order', t: 'cat', i: idx })
      }
    } catch {}
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{MONTHS[mo]} {yr}</span>
          <div className="cl" style={{ display: 'flex', gap: 14, alignItems: 'center', marginLeft: 14 }}>
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
          <div key={d} style={{ background: '#efefef', textAlign: 'center', fontSize: 9, color: '#666', padding: '7px 2px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', borderBottom: '1px solid #f0f0f0' }}>{d}</div>
        ))}
        {cells.map((cell, i) => {
          const evs = cell.cur ? (calEvs[cell.d] || []) : []
          return (
            <div key={i} className="cc" onClick={() => evs.length && onOpenRP(evs[0].i)} style={{ background: cell.today ? '#f0f0ff' : '#fff', minHeight: 72, padding: 6, cursor: evs.length ? 'pointer' : 'default', borderRight: '0.5px solid #f5f5f5', borderBottom: '0.5px solid #f5f5f5', opacity: cell.cur ? 1 : 0.3, transition: 'background 0.1s' }}
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
                return <div key={j} onClick={e => { e.stopPropagation(); onOpenRP(ev.i) }} style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, cursor: 'pointer', ...s[ev.t] || {} }}>{ev.l}</div>
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
  const [favs, setFavs] = useState<any[]>([])
  // Real API data
  const [apiOrders, setApiOrders] = useState<any[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || 'DC'

  useEffect(() => {
    fetch('/api/fm-order-history?page=0&size=50', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { content: [] })
      .then(d => {
        const list = d.content || d.orders || d.data || (Array.isArray(d) ? d : [])
        setApiOrders(list)
      })
      .catch(() => setApiOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [])

  const openRP = (i: number) => setRpIdx(i)
  const closeRP = () => setRpIdx(null)

  const pageConfig: Record<string, { title: string; sub: string; showTog: boolean; showNew: boolean }> = {
    orders: { title: 'Orders', sub: `${apiOrders.length} orders`, showTog: true, showNew: true },
    subscriptions: { title: 'Subscriptions', sub: 'Active subscriptions', showTog: false, showNew: false },
    history: { title: 'History', sub: 'All past orders', showTog: false, showNew: false },
    favorites: { title: 'Favorites', sub: 'Your saved restaurants', showTog: false, showNew: false },
    account: { title: 'Account settings', sub: 'Manage your profile', showTog: false, showNew: false },
    notifs: { title: 'Notifications', sub: '', showTog: false, showNew: false },
    payment: { title: 'Payment methods', sub: 'Manage saved cards', showTog: false, showNew: false },
    confirm: { title: 'Orders', sub: '', showTog: false, showNew: false },
    success: { title: 'Orders', sub: '', showTog: false, showNew: false },
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
        @media (max-width: 768px) {
          .ph { flex-wrap: wrap !important; padding: 9px 14px 0 !important; gap: 6px 8px !important; }
          .ph-div { display: none !important; }
          .ph-pills { order: 10; display: flex !important; width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; gap: 6px; padding: 4px 0 8px; }
          .ph-pills::-webkit-scrollbar { display: none; }
          .ph-pills button { flex-shrink: 0 !important; }
          .ph-meta-link { display: none !important; }
          .ps { display: none !important; }
          .sc { grid-template-columns: 1fr 1fr !important; }
          .cl { display: none !important; }
          .cc { min-height: 50px !important; padding: 3px !important; }
          .portal-cp { padding: 14px !important; }
          .rp { position: fixed !important; inset: auto 0 0 0 !important; width: 100% !important; min-width: 0 !important; max-height: 78vh; border-radius: 16px 16px 0 0 !important; border-left: none !important; border-top: 1px solid #f0f0f0 !important; box-shadow: 0 -6px 32px rgba(0,0,0,0.15) !important; z-index: 400 !important; }
          .rp-handle { display: block !important; }
          .rp-bd { display: block !important; }
          .ag2 { grid-template-columns: 1fr !important; }
          .ph-meta { gap: 10px !important; }
        }
      `}</style>

      {/* Top nav */}
      <div className="ph" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff', flexShrink: 0, position: 'sticky', top: 0, zIndex: 200 }}>
        <Link href="/" style={{ textDecoration: 'none', flexShrink: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}><span style={{ background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span><span style={{ color: '#999' }}> cater</span></span>
        </Link>
        <div className="ph-div" style={{ width: 1, height: 18, background: '#e8e8e8', flexShrink: 0 }} />
        <div className="ph-pills" style={{ display: 'contents' }}>
          {(['orders','subscriptions','history','favorites'] as const).map(p => (
            <button key={p} onClick={() => { setPage(p); closeRP() }} style={{ padding: '4px 12px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans',sans-serif", whiteSpace: 'nowrap', transition: 'all 0.12s', background: page === p ? '#1A1028' : '#efefef', color: page === p ? '#fff' : '#555' }}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        <div className="ph-meta" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
          <Link className="ph-meta-link" href="/fullmap" style={{ fontSize: 13, fontWeight: 500, color: '#555', textDecoration: 'none', fontFamily: "'DM Sans',sans-serif" }}>Catering Map</Link>
          <Link className="ph-meta-link" href="/faq" style={{ fontSize: 13, fontWeight: 500, color: '#555', textDecoration: 'none', fontFamily: "'DM Sans',sans-serif" }}>FAQ</Link>
          <div style={{ position: 'relative' }}>
            <button onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }} style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#fff', background: 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif" }}>
              {initials}
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 399 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#fff', border: '1px solid #e8e8e8', borderRadius: 12, boxShadow: '0 8px 28px rgba(0,0,0,0.12)', minWidth: 210, zIndex: 400, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 14px 10px', borderBottom: '1px solid #f0f0f0' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#111', fontFamily: "'DM Sans',sans-serif" }}>{user?.firstName} {user?.lastName}</div>
                    <div style={{ fontSize: 10, color: '#999', marginTop: 1, fontFamily: "'DM Sans',sans-serif" }}>{user?.email}</div>
                  </div>
                  <div style={{ padding: '5px 0' }}>
                    {[
                      { label: 'Payment methods', action: () => { setPage('payment'); setMenuOpen(false); closeRP() } },
                      { label: 'Notifications', action: () => { setPage('notifs'); setMenuOpen(false); closeRP() } },
                      { label: 'Account settings', action: () => { setPage('account'); setMenuOpen(false); closeRP() } },
                    ].map(item => (
                      <button key={item.label} onClick={item.action} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#444', fontWeight: 500, border: 'none', background: 'transparent', width: '100%', fontFamily: "'DM Sans',sans-serif", textAlign: 'left' }}
                        onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                        onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ height: 1, background: '#f0f0f0', margin: '3px 0' }} />
                  <div style={{ padding: '5px 0' }}>
                    <button onClick={onSignOut} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 12, color: '#E24B4A', fontWeight: 500, border: 'none', background: 'transparent', width: '100%', fontFamily: "'DM Sans',sans-serif", textAlign: 'left' }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.background = '#f5f5f5'}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                    >
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
        <div className="ps" style={{ width: 56, minWidth: 56, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#efefef', padding: '12px 0 16px', gap: 4 }}>
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
              {cfg.sub && <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{cfg.sub}</div>}
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

          <div className="portal-cp" style={{ flex: 1, padding: '18px 20px', overflowY: 'auto' }}>
            {/* Orders - Calendar */}
            {page === 'orders' && view === 'cal' && (
              <div>
                <div className="sc" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 18 }}>
                  {[
                    { l: 'Total orders', v: ordersLoading ? '…' : String(apiOrders.length), s: 'all time' },
                    { l: 'This month', v: ordersLoading ? '…' : String(apiOrders.filter((o: any) => { try { const d = new Date(o.orderDate || o.createdAt || ''); return d.getMonth() === new Date().getMonth() && d.getFullYear() === new Date().getFullYear() } catch { return false } }).length), s: MONTHS[new Date().getMonth()] },
                    { l: 'Last order', v: ordersLoading || apiOrders.length === 0 ? '—' : (() => { try { return new Date(apiOrders[0]?.orderDate || apiOrders[0]?.createdAt || '').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return '—' } })(), s: apiOrders[0]?.restaurantName || apiOrders[0]?.restaurant?.name || '', small: true },
                  ].map(s => (
                    <div key={s.l} style={{ background: '#efefef', borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 10, color: '#666', marginBottom: 4, fontWeight: 600 }}>{s.l}</div>
                      <div style={{ fontSize: s.small ? 16 : 22, fontWeight: 700, color: '#111', paddingTop: s.small ? 3 : 0 }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{s.s}</div>
                    </div>
                  ))}
                </div>
                <Calendar orders={apiOrders} onOpenRP={openRP} />
              </div>
            )}

            {/* Orders - List */}
            {page === 'orders' && view === 'list' && (
              <div>
                <div style={{ fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 2px', marginBottom: 8 }}>Orders</div>
                {ordersLoading ? (
                  <div style={{ color: '#aaa', fontSize: 13, fontFamily: "'DM Sans',sans-serif", padding: '20px 0' }}>Loading orders…</div>
                ) : apiOrders.length === 0 ? (
                  <div style={{ color: '#aaa', fontSize: 13, fontFamily: "'DM Sans',sans-serif", padding: '20px 0' }}>No orders found. <Link href="/fullmap" style={{ color: '#6B6EF9', fontWeight: 600, textDecoration: 'none' }}>Browse restaurants →</Link></div>
                ) : (
                  apiOrders.map((o, i) => <OLR key={i} o={{
                    name: o.restaurantName || o.restaurant?.name || 'Order',
                    emoji: '🍽️',
                    people: o.headcount || o.numberOfPeople || '—',
                    service: o.orderType || o.serviceType || '—',
                    paid: o.status !== 'UNPAID',
                    tag: '',
                    tagLabel: o.status || '',
                    amt: o.total || o.totalAmount || 0,
                    date: o.orderDate || o.deliveryDate || o.createdAt || '—',
                  }} onClick={() => openRP(i)} />)
                )}
                <DiscoverCTA />
              </div>
            )}

            {/* Confirm */}
            {page === 'confirm' && (
              <div style={{ maxWidth: 400 }}>
                <div style={{ background: '#efefef', borderRadius: 10, padding: 14, marginBottom: 14, border: '1px solid #ebebeb' }}>
                  <div style={{ fontSize: 10, color: '#666', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Order summary</div>
                  <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                    {[['Restaurant','Taim — Nolita'],['Items','Team Lunch Box'],['Headcount','30 people'],['Type','Recurring — weekly'],['Service','Delivery'],['Order date','Every Tuesday'],['Order time','12:00 PM'],['Est. per order','$840']].map(([l,v],i) => (
                      <tr key={i}><td style={{ padding: '3px 0', borderTop: i === 7 ? '1px solid #f0f0f0' : 'none', paddingTop: i === 7 ? 7 : 3, fontWeight: i === 7 ? 700 : 400, color: i === 7 ? '#111' : '#bbb' }}>{l}</td><td style={{ textAlign: 'right', fontWeight: i === 7 ? 700 : 600, color: i === 7 ? '#5B6FE8' : '#111', fontSize: i === 7 ? 15 : 11 }}>{v}</td></tr>
                    ))}
                  </table>
                </div>
                <div style={{ background: '#E1F5EE', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: '#085041', marginBottom: 14, lineHeight: 1.6 }}>A confirmation email will be sent 24 hours before each order. You can skip or cancel anytime.</div>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 14 }}>Payment: <span style={{ color: '#111', fontWeight: 600 }}>Visa ···4821</span> &nbsp;·&nbsp; <span style={{ color: '#6B6EF9', cursor: 'pointer', fontWeight: 600 }}>Change</span></div>
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
                <div style={{ marginBottom: 12 }}><span style={{ fontSize: 10, color: '#666', display: 'block', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Card number</span><input type="text" placeholder="1234 5678 9012 3456" style={{ width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#efefef', fontFamily: "'DM Sans',sans-serif", outline: 'none' }} /></div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                  {['Expiry','CVC'].map(l => <div key={l} style={{ flex: 1 }}><span style={{ fontSize: 10, color: '#666', display: 'block', marginBottom: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{l}</span><input type="text" placeholder={l === 'Expiry' ? 'MM / YY' : '123'} style={{ width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#efefef', fontFamily: "'DM Sans',sans-serif", outline: 'none' }} /></div>)}
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
                <div style={{ fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '0 2px', marginBottom: 8 }}>All past orders</div>
                {ordersLoading ? (
                  <div style={{ color: '#aaa', fontSize: 13, fontFamily: "'DM Sans',sans-serif", padding: '20px 0' }}>Loading orders…</div>
                ) : apiOrders.length === 0 ? (
                  <div style={{ color: '#aaa', fontSize: 13, fontFamily: "'DM Sans',sans-serif", padding: '20px 0' }}>No orders yet.</div>
                ) : (
                  apiOrders.map((o, i) => <OLR key={i} o={{
                    name: o.restaurantName || o.restaurant?.name || 'Order',
                    emoji: '🍽️',
                    people: o.headcount || '—',
                    service: o.orderType || '—',
                    paid: o.status !== 'UNPAID',
                    tag: '',
                    tagLabel: o.status || '',
                    amt: o.total || o.totalAmount || 0,
                    date: o.orderDate || o.createdAt || '—',
                  }} onClick={() => openRP(i)} />)
                )}
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
                <div style={{ padding: '8px 2px 14px', fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notifications</div>
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
                <div style={{ padding: '8px 2px 14px', fontSize: 11, color: '#666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Payment methods</div>
                <div style={{ border: '1px solid #ebebeb', borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <IconCardLg />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#111' }}>No payment method on file</div>
                      <div style={{ fontSize: 10, color: '#666', marginTop: 1 }}>Add a card to place orders</div>
                    </div>
                  </div>
                </div>
                <button style={{ background: 'transparent', border: '1px solid #e0e0e0', borderRadius: 8, padding: '6px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#555', fontFamily: "'DM Sans',sans-serif" }}>+ Add payment method</button>
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        {rpIdx !== null && (
          <>
            <div className="rp-bd" onClick={closeRP} style={{ display: 'none', position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)', zIndex: 399 }} />
            <RightPanel order={apiOrders[rpIdx] || null} onClose={closeRP} onPayment={() => { closeRP(); setPage('payfail') }} />
          </>
        )}
      </div>
    </div>
  )
}

// ── Account Form ──────────────────────────────────────────────────────────────
function AccountForm({ user }: { user: any }) {
  const { refreshUser } = useAuthContext()
  const [firstName, setFirstName] = useState(user?.firstName || '')
  const [lastName, setLastName] = useState(user?.lastName || '')
  const [email, setEmail] = useState(user?.email || '')
  const [phone, setPhone] = useState(user?.phoneNumber || '')
  const [saved, setSaved] = useState(false)

  const fi: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #e8e8e8', borderRadius: 7, fontSize: 12, color: '#111', background: '#efefef', fontFamily: "'DM Sans',sans-serif", outline: 'none' }
  const fl: React.CSSProperties = { fontSize: 10, color: '#666', marginBottom: 3, display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }

  async function save() {
    try {
      await fetch('/api/fm-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, phoneNumber: phone }),
        credentials: 'include',
      })
      await refreshUser()
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch {}
  }

  return (
    <div style={{ maxWidth: 440 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#111', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Personal info</div>
      <div className="ag2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><span style={fl}>First name</span><input style={fi} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
        <div><span style={fl}>Last name</span><input style={fi} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
      </div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Email address</span><input style={fi} type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div style={{ marginBottom: 12 }}><span style={fl}>Phone number</span><input style={fi} type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></div>
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

// ── Root ──────────────────────────────────────────────────────────────────────
export default function PortalPage() {
  const { user, isLoading, logout } = useAuthContext()

  if (isLoading) return <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif", color: '#666' }}>Loading…</div>

  // Middleware handles redirect; show loading if user is null but still initializing
  if (!user) return <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'DM Sans',sans-serif", color: '#666' }}>Redirecting…</div>

  async function signOut() {
    await logout()
    window.location.href = '/'
  }

  return (
    <Portal user={user} onSignOut={signOut} />
  )
}
