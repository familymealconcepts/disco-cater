'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'
const DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY']

// ── Types ──────────────────────────────────────────────────────────────────────

interface RepeatWeekDay { days: string; fromPickUpTime: string; toPickUpTime: string }

interface FmSchedule {
  prepTime?: number
  startDate?: string
  endDate?: string
  rollingAvailability?: number
  cutOff?: string
  repeatWeekDays?: RepeatWeekDay[]
  skippedDays?: string[]
}

interface FmSettings {
  deliveryType?: string
  pickupOrderMinimum?: number
  deliveryOrderMinimum?: number
  menuAvailability?: string[]
  serviceCharge?: number | null
  serviceChargeName?: string | null
  tipOption?: { tipsType: string; tipsPrice: number }
}

interface FmMenu {
  reference: string
  name: string
  scheduleOption?: FmSchedule
  settings?: FmSettings
}

interface FmPackage {
  reference: string
  name: string
  description?: string | null
  price: number
  serves?: string | number | null
  image?: { reference: string; availableResolutions?: number[] } | null
  available?: boolean
  allowedSpecialInstructions?: boolean
  extraItemsGroups?: any[]
}

interface FmCategory { reference: string; name: string; mealPackages: FmPackage[] }
interface MenuSection { menu: FmMenu; categories: FmCategory[] }

interface Restaurant {
  name: string; address?: string; cuisine?: string; cuisines?: string[]
  description?: string; image?: any; orderUrl?: string
  isDisco?: boolean; location?: string; tags?: string[]
}

interface CartItem { pkg: FmPackage; quantity: number }

// ── Helpers ────────────────────────────────────────────────────────────────────

function computeDates(sched: FmSchedule): string[] {
  const avail = new Set(sched.repeatWeekDays?.map(d => d.days) ?? [])
  if (!avail.size) return []
  const now = new Date()
  const earliest = new Date(now.getTime() + (sched.prepTime ?? 24) * 3_600_000)
  const end = sched.endDate
    ? new Date(sched.endDate + 'T23:59:59')
    : new Date(now.getTime() + (sched.rollingAvailability ?? 90) * 86_400_000)
  const skipped = new Set(sched.skippedDays ?? [])
  const dates: string[] = []
  const cur = new Date(earliest); cur.setHours(0, 0, 0, 0)
  while (cur <= end && dates.length < 60) {
    const iso = cur.toISOString().slice(0, 10)
    if (avail.has(DAY_NAMES[cur.getDay()]) && !skipped.has(iso)) dates.push(iso)
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function computeTimes(sched: FmSchedule, dateStr: string): string[] {
  if (!dateStr) return []
  const dayName = DAY_NAMES[new Date(dateStr + 'T12:00:00').getDay()]
  const cfg = sched.repeatWeekDays?.find(d => d.days === dayName)
  if (!cfg) return []
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0) }
  const times: string[] = []
  for (let m = toMin(cfg.fromPickUpTime); m < toMin(cfg.toPickUpTime); m += 30) {
    times.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`)
  }
  return times
}

function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) }
  catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) }
  catch { return t }
}
function fmt$(n: number) { return `$${n % 1 === 0 ? n : n.toFixed(2)}` }
function pkgImg(ref: string, size = 300) {
  return `https://api.familymeal.com/public-api/images/${ref}/download?size=${size}`
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function RestaurantClient({
  restaurant, fmSlug, fmRef, menuData, slug,
}: {
  restaurant: Restaurant; fmSlug: string | null; fmRef: string | null
  menuData: MenuSection[]; slug: string
}) {
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [cart, setCart] = useState<CartItem[]>([])
  const [orderType, setOrderType] = useState<'PICKUP'|'DELIVERY'>('PICKUP')
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [addr, setAddr] = useState({ line1: '', city: '', state: '', zip: '' })
  const [tipPct, setTipPct] = useState<number | null>(null)
  const [headerImgError, setHeaderImgError] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeSection = menuData[activeMenuIdx]
  const firstMenu = menuData[0]?.menu
  const sched = firstMenu?.scheduleOption
  const settings = firstMenu?.settings

  const availDates = useMemo(() => sched ? computeDates(sched) : [], [sched])
  const availTimes = useMemo(() => sched && selDate ? computeTimes(sched, selDate) : [], [sched, selDate])

  const menuAvail = settings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
  const defaultTip = settings?.tipOption?.tipsPrice ?? 15
  const activeTip = tipPct ?? defaultTip
  const minOrder = orderType === 'DELIVERY'
    ? (settings?.deliveryOrderMinimum ?? settings?.pickupOrderMinimum ?? 0)
    : (settings?.pickupOrderMinimum ?? 0)

  // ── Pricing ───────────────────────────────────────────────────────────────
  const subtotal = cart.reduce((s, i) => s + i.pkg.price * i.quantity, 0)
  const tipAmt = Math.round(subtotal * activeTip) / 100
  const svcPct = settings?.serviceCharge ?? 0
  const svcAmt = svcPct ? Math.round(subtotal * svcPct) / 100 : 0
  const clientTotal = subtotal + tipAmt + svcAmt

  // ── Announcements ─────────────────────────────────────────────────────────
  const notices: string[] = []
  if (sched?.prepTime) notices.push(`${sched.prepTime}hr advance notice`)
  if (minOrder) notices.push(`${fmt$(minOrder)} minimum`)
  if (menuAvail.length) notices.push(menuAvail.map(t => t === 'PICKUP' ? 'Pickup' : 'Delivery').join(' & '))

  // ── Cart helpers ──────────────────────────────────────────────────────────
  const cartQty = (ref: string) => cart.find(i => i.pkg.reference === ref)?.quantity ?? 0
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0)
  const belowMin = minOrder > 0 && subtotal < minOrder && cart.length > 0

  const addItem = (pkg: FmPackage) => setCart(prev => {
    const i = prev.findIndex(x => x.pkg.reference === pkg.reference)
    if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], quantity: n[i].quantity + 1 }; return n }
    return [...prev, { pkg, quantity: 1 }]
  })
  const updateQty = (ref: string, delta: number) =>
    setCart(prev => prev.map(i => i.pkg.reference === ref ? { ...i, quantity: i.quantity + delta } : i).filter(i => i.quantity > 0))

  // ── Header image ──────────────────────────────────────────────────────────
  const headerImg = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace(/^image-/,'').replace(/-([a-z]+)$/,'.$1')}`
    : null
  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  // ── Input style ───────────────────────────────────────────────────────────
  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 11px', border: '1.5px solid #e8e8e8',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
  }

  // ── Cart panel (desktop sidebar + mobile overlay share this) ──────────────
  const cartPanel = (
    <div>
      {/* ── Order config ── */}
      {fmSlug && (
        <div style={{ borderBottom: '1px solid #f4f4f4', padding: '14px 16px 16px' }}>

          {/* Order type toggle */}
          {menuAvail.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Order Type</div>
              <div style={{ display: 'flex', background: '#f4f4f8', borderRadius: 9, padding: 3, gap: 3 }}>
                {(['PICKUP','DELIVERY'] as const).filter(t => menuAvail.includes(t)).map(type => (
                  <button key={type} onClick={() => setOrderType(type)} style={{
                    flex: 1, padding: '7px 4px', border: 'none', borderRadius: 7, cursor: 'pointer',
                    background: orderType === type ? '#fff' : 'transparent',
                    color: orderType === type ? DARK : '#999', fontFamily: F, fontSize: 12,
                    fontWeight: orderType === type ? 700 : 500,
                    boxShadow: orderType === type ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                  }}>
                    {type === 'DELIVERY' ? '🚚 Delivery' : '🏃 Pickup'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Date picker */}
          {availDates.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Date</div>
              <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
                {availDates.slice(0, 14).map(d => {
                  const sel = d === selDate
                  const dt = new Date(d + 'T12:00:00')
                  const wday = dt.toLocaleDateString('en-US', { weekday: 'short' })
                  const mday = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  return (
                    <button key={d} onClick={() => { setSelDate(d); setSelTime('') }} style={{
                      flexShrink: 0, padding: '5px 8px', borderRadius: 8, cursor: 'pointer', fontFamily: F, textAlign: 'center',
                      border: `2px solid ${sel ? BLUE : '#e8e8e8'}`,
                      background: sel ? '#EEF0FD' : '#fff',
                    }}>
                      <div style={{ fontSize: 9, color: sel ? INDIGO : '#ccc' }}>{wday}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: sel ? BLUE : DARK }}>{mday}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Time picker */}
          {selDate && availTimes.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Pickup Time</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {availTimes.map(t => {
                  const sel = t === selTime
                  return (
                    <button key={t} onClick={() => setSelTime(t)} style={{
                      padding: '5px 9px', borderRadius: 7, cursor: 'pointer', fontFamily: F, fontSize: 11,
                      border: `2px solid ${sel ? BLUE : '#e8e8e8'}`,
                      background: sel ? '#EEF0FD' : '#fff',
                      color: sel ? BLUE : DARK, fontWeight: sel ? 700 : 500,
                    }}>
                      {fmtTime(t)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Delivery address */}
          {orderType === 'DELIVERY' && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Delivery Address</div>
              <input value={addr.line1} onChange={e => setAddr(a => ({...a, line1: e.target.value}))}
                placeholder="Street address" style={{ ...inp, marginBottom: 5 }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 68px', gap: 5 }}>
                <input value={addr.city} onChange={e => setAddr(a => ({...a, city: e.target.value}))} placeholder="City" style={inp} />
                <input value={addr.state} onChange={e => setAddr(a => ({...a, state: e.target.value.toUpperCase()}))} placeholder="ST" maxLength={2} style={inp} />
                <input value={addr.zip} onChange={e => setAddr(a => ({...a, zip: e.target.value}))} placeholder="ZIP" style={inp} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Cart items ── */}
      <div style={{ padding: '0 16px' }}>
        {cart.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0 8px', color: '#bbb', fontSize: 13, lineHeight: 1.7 }}>
            Browse the menu and click<br /><strong style={{ color: '#aaa' }}>Add to Order</strong> to get started
          </div>
        ) : (
          <>
            <div style={{ paddingTop: 8 }}>
              {cart.map(item => (
                <div key={item.pkg.reference} style={{ padding: '10px 0', borderBottom: '1px solid #f4f4f4', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: DARK, lineHeight: 1.3, marginBottom: 1 }}>{item.pkg.name}</div>
                    {item.pkg.serves && <div style={{ fontSize: 11, color: '#bbb' }}>serves {item.pkg.serves}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => updateQty(item.pkg.reference, -1)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 18, textAlign: 'center' }}>{item.quantity}</span>
                    <button onClick={() => addItem(item.pkg)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 48, textAlign: 'right' }}>{fmt$(item.pkg.price * item.quantity)}</div>
                </div>
              ))}
            </div>

            {/* ── Pricing breakdown ── */}
            <div style={{ paddingTop: 12 }}>
              {/* Subtotal */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#666' }}>Subtotal</span>
                <span style={{ color: DARK, fontWeight: 600 }}>{fmt$(subtotal)}</span>
              </div>

              {/* Delivery fee */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#666' }}>Delivery fee</span>
                {orderType === 'PICKUP'
                  ? <span style={{ color: '#22C55E', fontWeight: 600 }}>Free</span>
                  : <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated after address</span>}
              </div>

              {/* Service fee */}
              {svcPct > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                  <span style={{ color: '#666' }}>{settings?.serviceChargeName || 'Service fee'} ({svcPct}%)</span>
                  <span style={{ color: DARK, fontWeight: 600 }}>{fmt$(svcAmt)}</span>
                </div>
              )}

              {/* Tax */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 10 }}>
                <span style={{ color: '#666' }}>Tax</span>
                <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>
              </div>

              {/* Tip */}
              <div style={{ background: '#f8f8fc', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#666' }}>Tip</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmt$(tipAmt)}</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[0, 10, 15, 20, 25].map(pct => (
                    <button key={pct} onClick={() => setTipPct(pct)} style={{
                      flex: 1, padding: '5px 2px', borderRadius: 7, cursor: 'pointer', fontFamily: F, fontSize: 11,
                      border: `1.5px solid ${activeTip === pct ? BLUE : '#e8e8e8'}`,
                      background: activeTip === pct ? '#EEF0FD' : '#fff',
                      color: activeTip === pct ? BLUE : '#666',
                      fontWeight: activeTip === pct ? 700 : 500,
                    }}>
                      {pct === 0 ? 'None' : `${pct}%`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Total */}
              <div style={{ borderTop: '2px solid #f0f0f0', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Total</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: DARK }}>{fmt$(clientTotal)}</span>
                  {orderType === 'DELIVERY' && <div style={{ fontSize: 10, color: '#bbb' }}>+ delivery & tax</div>}
                </div>
              </div>

              {/* Below minimum warning */}
              {belowMin && (
                <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#92400E' }}>
                  {fmt$(minOrder - subtotal)} more to meet the {fmt$(minOrder)} minimum
                </div>
              )}

              {/* CTA — TODO: replace href with native checkout once FM order update API is confirmed working */}
              <a href={fmSlug ? `https://www.familymeal.com/disco/${fmSlug}` : '#'}
                target="_blank" rel="noopener noreferrer"
                onClick={e => { if (!fmSlug || cart.length === 0 || belowMin) e.preventDefault() }}
                style={{
                  display: 'block', textAlign: 'center', padding: '13px',
                  background: cart.length > 0 && !belowMin ? BLUE : '#e8e8e8',
                  color: cart.length > 0 && !belowMin ? '#fff' : '#bbb',
                  borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none',
                  boxShadow: cart.length > 0 && !belowMin ? '0 4px 14px rgba(91,111,232,0.25)' : 'none',
                  fontFamily: F, transition: 'all 0.15s',
                  cursor: cart.length > 0 && !belowMin ? 'pointer' : 'default',
                }}>
                Place Order →
              </a>
            </div>
          </>
        )}

        {cart.length === 0 && fmSlug && (
          <div style={{ paddingBottom: 16 }}>
            <a href={`https://www.familymeal.com/disco/${fmSlug}`} target="_blank" rel="noopener noreferrer"
              style={{ display: 'block', textAlign: 'center', padding: '11px', background: '#f4f4f8', color: '#888', borderRadius: 10, fontSize: 13, fontWeight: 500, textDecoration: 'none' }}>
              View on FamilyMeal →
            </a>
          </div>
        )}
      </div>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {notices.length > 0 && (
        <div style={{ background: DARK, color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: 500, textAlign: 'center', padding: '8px 16px', letterSpacing: '0.03em' }}>
          {notices.join('  ·  ')}
        </div>
      )}

      {/* Restaurant header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '20px 24px 0' }}>
          <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            ← Back to Catering Map
          </Link>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {headerImg && !headerImgError
                ? <img src={headerImg} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setHeaderImgError(true)} />
                : <span style={{ fontSize: 32 }}>🍽️</span>}
            </div>
            <div style={{ flex: 1 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 20, marginBottom: 6, letterSpacing: '0.06em' }}>🪩 PREMIUM</div>
              )}
              <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{restaurant.name}</h1>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 6 }}>📍 {restaurant.location || restaurant.address}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {tags.map(t => <span key={t} style={{ background: '#f0f0f0', color: '#555', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
                {restaurant.tags?.map(t => <span key={t} style={{ background: '#EEEDFE', color: '#3C3489', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
              </div>
            </div>
          </div>

          {menuData.length > 1 && (
            <div style={{ display: 'flex', overflowX: 'auto', borderTop: '1px solid #f0f0f0' }}>
              {menuData.map((s, i) => (
                <button key={s.menu.reference} onClick={() => setActiveMenuIdx(i)} style={{
                  padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: activeMenuIdx === i ? 700 : 500,
                  color: activeMenuIdx === i ? INDIGO : '#666',
                  borderBottom: `2px solid ${activeMenuIdx === i ? INDIGO : 'transparent'}`,
                  fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0,
                }}>{s.menu.name}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '28px 24px 120px', display: 'flex', gap: 24, alignItems: 'flex-start' }}>

        {/* LEFT: packages */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {menuData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '72px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#666', marginBottom: 8 }}>Menu details coming soon</div>
              <div style={{ fontSize: 14, color: '#aaa', marginBottom: 20 }}>Contact the restaurant to discuss catering options</div>
              {fmSlug && (
                <a href={`https://www.familymeal.com/disco/${fmSlug}`} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'inline-block', padding: '11px 22px', background: BLUE, color: '#fff', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
                  Order on FamilyMeal →
                </a>
              )}
            </div>
          ) : (
            activeSection?.categories.map(cat => (
              <div key={cat.reference} style={{ marginBottom: 36 }}>
                {(activeSection.categories.length > 1 || cat.name !== activeSection.menu.name) && (
                  <h2 style={{ fontSize: 17, fontWeight: 800, color: DARK, margin: '0 0 16px', letterSpacing: '-0.01em' }}>{cat.name}</h2>
                )}
                <div className="pkg-grid">
                  {cat.mealPackages.filter(p => p.available !== false).map(pkg => {
                    const qty = cartQty(pkg.reference)
                    const imgUrl = pkg.image?.reference ? pkgImg(pkg.image.reference, 300) : null
                    const perUnit = pkg.serves && Number(pkg.serves) > 1

                    return (
                      <div key={pkg.reference} style={{
                        background: '#fff', borderRadius: 16, overflow: 'hidden',
                        border: `1.5px solid ${qty > 0 ? BLUE : '#f0f0f0'}`,
                        display: 'flex', flexDirection: 'column',
                        boxShadow: qty > 0 ? '0 4px 20px rgba(91,111,232,0.12)' : '0 1px 4px rgba(0,0,0,0.04)',
                        transition: 'all 0.15s',
                      }}>
                        {/* Image */}
                        <div style={{ height: 160, background: 'linear-gradient(135deg,#f4f4fb 0%,#eaeaf6 100%)', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
                          {imgUrl && (
                            <img src={imgUrl} alt={pkg.name}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          )}
                          {qty > 0 && (
                            <div style={{ position: 'absolute', top: 8, right: 8, background: BLUE, color: '#fff', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>{qty}</div>
                          )}
                        </div>

                        {/* Body */}
                        <div style={{ padding: '14px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: DARK, marginBottom: 3, lineHeight: 1.3 }}>{pkg.name}</div>
                          {pkg.serves && <div style={{ fontSize: 11, color: '#888', marginBottom: 5 }}>Serves {pkg.serves}</div>}
                          {pkg.description && (
                            <p style={{
                              fontSize: 12, color: '#666', lineHeight: 1.5, margin: '0 0 10px', flex: 1,
                              display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            } as React.CSSProperties}>
                              {pkg.description}
                            </p>
                          )}

                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto', paddingTop: 8 }}>
                            <div style={{ fontSize: 17, fontWeight: 800, color: BLUE }}>
                              {fmt$(pkg.price)}
                              <span style={{ fontSize: 11, fontWeight: 500, color: '#888' }}>/{perUnit ? 'pkg' : 'pp'}</span>
                            </div>

                            {qty > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <button onClick={() => updateQty(pkg.reference, -1)} style={{ width: 30, height: 30, borderRadius: 8, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 16, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                                <span style={{ fontSize: 15, fontWeight: 800, color: BLUE, minWidth: 22, textAlign: 'center' }}>{qty}</span>
                                <button onClick={() => addItem(pkg)} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: BLUE, cursor: 'pointer', fontSize: 16, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                              </div>
                            ) : (
                              <button onClick={() => addItem(pkg)} style={{
                                padding: '8px 14px', background: BLUE, color: '#fff', border: 'none',
                                borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                                fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.25)', whiteSpace: 'nowrap',
                              }}>Add to Order</button>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* RIGHT: sticky cart */}
        <div className="order-sidebar" style={{ width: 340, flexShrink: 0 }}>
          <div style={{ position: 'sticky', top: 80, background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', boxShadow: '0 4px 24px rgba(0,0,0,0.06)', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
            <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
              <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
            </div>
            {cartPanel}
          </div>
        </div>
      </div>

      {/* Mobile bottom bar */}
      <div className="mobile-order-bar" style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #f0f0f0', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', zIndex: 100 }}>
        <button onClick={() => setMobileCartOpen(true)} style={{
          width: '100%', padding: '14px',
          background: cartCount > 0 ? BLUE : '#e8e8e8', color: cartCount > 0 ? '#fff' : '#bbb',
          border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer',
          fontFamily: F, boxShadow: cartCount > 0 ? '0 4px 14px rgba(91,111,232,0.25)' : 'none',
        }}>
          {cartCount > 0 ? `${cartCount} item${cartCount !== 1 ? 's' : ''} · ${fmt$(subtotal)} — View Order` : 'Browse Menu → Start Order'}
        </button>
      </div>

      {/* Mobile cart overlay */}
      {mobileCartOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
              <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
            </div>
            <button onClick={() => setMobileCartOpen(false)} style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
          {cartPanel}
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .pkg-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        input:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.1) !important; }
        @media (max-width: 900px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
        @media (max-width: 580px) {
          .pkg-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )
}
