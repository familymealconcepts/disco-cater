'use client'
import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'
const DAY_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY']
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

// ── Types ──────────────────────────────────────────────────────────────────────

interface RepeatWeekDay { days: string; fromPickUpTime: string; toPickUpTime: string }

interface FmSchedule {
  prepTime?: number; startDate?: string; endDate?: string
  rollingAvailability?: number; cutOff?: string
  repeatWeekDays?: RepeatWeekDay[]; skippedDays?: string[]
}

interface FmSettings {
  deliveryType?: string; pickupOrderMinimum?: number; deliveryOrderMinimum?: number
  menuAvailability?: string[]; serviceCharge?: number | null; serviceChargeName?: string | null
  tipOption?: { tipsType: string; tipsPrice: number }
}

interface FmMenu { reference: string; name: string; scheduleOption?: FmSchedule; settings?: FmSettings }

interface FmPackage {
  reference: string; name: string; description?: string | null; price: number
  serves?: string | number | null
  image?: { reference: string; availableResolutions?: number[] } | null
  available?: boolean; allowedSpecialInstructions?: boolean; extraItemsGroups?: any[]
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
  while (cur <= end && dates.length < 90) {
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
    times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`)
  }
  return times
}

function fmtDateShort(d: string) {
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

// ── Calendar ───────────────────────────────────────────────────────────────────

function MonthCalendar({
  year, month, availSet, todayIso, selDate, onSelect,
}: {
  year: number; month: number; availSet: Set<string>; todayIso: string
  selDate: string; onSelect: (d: string) => void
}) {
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (string | null)[] = Array(firstDow).fill(null)
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  }
  // Pad to full rows
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(n => (
          <div key={n} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#aaa', padding: '6px 0' }}>{n}</div>
        ))}
        {cells.map((iso, i) => {
          if (!iso) return <div key={`e${i}`} />
          const avail = availSet.has(iso)
          const sel = iso === selDate
          const isToday = iso === todayIso
          return (
            <button key={iso} onClick={() => avail && onSelect(iso)} disabled={!avail}
              style={{
                width: '100%', aspectRatio: '1', border: sel ? 'none' : isToday ? `2px solid ${BLUE}` : 'none',
                borderRadius: '50%', cursor: avail ? 'pointer' : 'default', fontFamily: F,
                fontSize: 13, fontWeight: sel || isToday ? 700 : 400,
                background: sel ? BLUE : 'transparent',
                color: sel ? '#fff' : avail ? DARK : '#ddd',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              {parseInt(iso.slice(-2))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function RestaurantClient({
  restaurant, fmSlug, fmRef, menuData, slug,
}: {
  restaurant: Restaurant; fmSlug: string | null; fmRef: string | null
  menuData: MenuSection[]; slug: string
}) {
  // ── Menu ─────────────────────────────────────────────────────────────────
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [headerImgError, setHeaderImgError] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)

  // ── Cart ──────────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartItem[]>([])
  const [tipPct, setTipPct] = useState<number | null>(null)
  const [addr, setAddr] = useState({ line1: '', city: '', state: '', zip: '' })

  // ── Confirmed order config (shown in SelectionBar) ────────────────────────
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [hasSelection, setHasSelection] = useState(false)

  // ── Date picker modal state ───────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false)
  const [tempDate, setTempDate] = useState('')
  const [tempTime, setTempTime] = useState('')
  const [tempType, setTempType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const now = new Date()
  const todayIso = now.toISOString().slice(0, 10)
  const [calYear, setCalYear] = useState(now.getFullYear())
  const [calMonth, setCalMonth] = useState(now.getMonth())

  // ── Data ─────────────────────────────────────────────────────────────────
  const activeSection = menuData[activeMenuIdx]
  const firstMenu = menuData[0]?.menu
  const sched = firstMenu?.scheduleOption
  const settings = firstMenu?.settings
  const menuAvail = settings?.menuAvailability ?? ['PICKUP', 'DELIVERY']
  const defaultTip = settings?.tipOption?.tipsPrice ?? 15
  const activeTip = tipPct ?? defaultTip
  const minOrder = orderType === 'DELIVERY'
    ? (settings?.deliveryOrderMinimum ?? settings?.pickupOrderMinimum ?? 0)
    : (settings?.pickupOrderMinimum ?? 0)

  const availDates = useMemo(() => sched ? computeDates(sched) : [], [sched])
  const availSet = useMemo(() => new Set(availDates), [availDates])
  const modalTimes = useMemo(() => sched && tempDate ? computeTimes(sched, tempDate) : [], [sched, tempDate])
  const confirmedTimes = useMemo(() => sched && selDate ? computeTimes(sched, selDate) : [], [sched, selDate])

  // ── Auto-open picker on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (!fmSlug || availDates.length === 0) return
    // Pre-select first available date and initialize calendar to that month
    const first = availDates[0]
    const d = new Date(first + 'T12:00:00')
    setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    setTempDate(first)
    // Default order type
    const defaultType = menuAvail.includes('PICKUP') ? 'PICKUP' : 'DELIVERY'
    setTempType(defaultType as 'PICKUP' | 'DELIVERY')
    setPickerOpen(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Picker handlers ───────────────────────────────────────────────────────
  function openPicker() {
    setTempDate(selDate); setTempTime(selTime); setTempType(orderType)
    if (selDate) {
      const d = new Date(selDate + 'T12:00:00')
      setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    }
    setPickerOpen(true)
  }

  function confirmPicker() {
    if (!tempDate || !tempTime) return
    setSelDate(tempDate); setSelTime(tempTime); setOrderType(tempType)
    setHasSelection(true); setPickerOpen(false)
  }

  function closePicker() { setPickerOpen(false) }

  function handleTempDateSelect(d: string) {
    setTempDate(d); setTempTime('')
  }

  function prevMonth() {
    if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11) }
    else setCalMonth(m => m - 1)
  }
  function nextMonth() {
    if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0) }
    else setCalMonth(m => m + 1)
  }

  // ── Pricing ───────────────────────────────────────────────────────────────
  const subtotal = cart.reduce((s, i) => s + i.pkg.price * i.quantity, 0)
  const tipAmt = Math.round(subtotal * activeTip) / 100
  const svcPct = settings?.serviceCharge ?? 0
  const svcAmt = svcPct ? Math.round(subtotal * svcPct) / 100 : 0
  const clientTotal = subtotal + tipAmt + svcAmt
  const belowMin = minOrder > 0 && subtotal < minOrder && cart.length > 0

  // ── Announcements ─────────────────────────────────────────────────────────
  const notices: string[] = []
  if (sched?.prepTime) notices.push(`${sched.prepTime}hr advance notice`)
  if (minOrder) notices.push(`${fmt$(minOrder)} minimum`)
  if (menuAvail.length) notices.push(menuAvail.map(t => t === 'PICKUP' ? 'Pickup' : 'Delivery').join(' & '))

  // ── Cart helpers ──────────────────────────────────────────────────────────
  const cartQty = (ref: string) => cart.find(i => i.pkg.reference === ref)?.quantity ?? 0
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0)

  const addItem = (pkg: FmPackage) => setCart(prev => {
    const i = prev.findIndex(x => x.pkg.reference === pkg.reference)
    if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], quantity: n[i].quantity + 1 }; return n }
    return [...prev, { pkg, quantity: 1 }]
  })
  const updateQty = (ref: string, delta: number) =>
    setCart(prev => prev.map(i => i.pkg.reference === ref ? { ...i, quantity: i.quantity + delta } : i).filter(i => i.quantity > 0))

  // ── Header image ──────────────────────────────────────────────────────────
  const headerImg = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')}`
    : null
  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  // ── Input style ───────────────────────────────────────────────────────────
  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 11px', border: '1.5px solid #e8e8e8',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
  }

  // ── Cart sidebar panel ────────────────────────────────────────────────────
  const cartPanel = (
    <div>
      {/* Selected order config summary (inside sidebar) */}
      {hasSelection && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4', background: '#fafafa' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: '#555' }}>
              <span style={{ fontWeight: 700 }}>{fmtDateShort(selDate)}</span>
              {selTime && <span style={{ color: '#888' }}> · {fmtTime(selTime)}</span>}
              <span style={{ color: '#888' }}> · {orderType === 'PICKUP' ? 'Pickup' : 'Delivery'}</span>
            </div>
            <button onClick={openPicker} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: '2px 6px', borderRadius: 6 }}>Edit</button>
          </div>
        </div>
      )}

      {!hasSelection && fmSlug && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <button onClick={openPicker} style={{ width: '100%', padding: '10px', background: '#f0f0f8', border: `1.5px dashed ${INDIGO}30`, borderRadius: 10, cursor: 'pointer', fontFamily: F, fontSize: 13, fontWeight: 600, color: INDIGO }}>
            📅 Select Date & Time
          </button>
        </div>
      )}

      {/* Delivery address */}
      {hasSelection && orderType === 'DELIVERY' && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Delivery Address</div>
          <input value={addr.line1} onChange={e => setAddr(a => ({ ...a, line1: e.target.value }))}
            placeholder="Street address" style={{ ...inp, marginBottom: 5 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 68px', gap: 5 }}>
            <input value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} placeholder="City" style={inp} />
            <input value={addr.state} onChange={e => setAddr(a => ({ ...a, state: e.target.value.toUpperCase() }))} placeholder="ST" maxLength={2} style={inp} />
            <input value={addr.zip} onChange={e => setAddr(a => ({ ...a, zip: e.target.value }))} placeholder="ZIP" style={inp} />
          </div>
        </div>
      )}

      {/* Cart items */}
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

            {/* Pricing */}
            <div style={{ paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#666' }}>Subtotal</span>
                <span style={{ color: DARK, fontWeight: 600 }}>{fmt$(subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#666' }}>Delivery fee</span>
                {orderType === 'PICKUP'
                  ? <span style={{ color: '#22C55E', fontWeight: 600 }}>Free</span>
                  : <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated after address</span>}
              </div>
              {svcPct > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                  <span style={{ color: '#666' }}>{settings?.serviceChargeName || 'Service fee'} ({svcPct}%)</span>
                  <span style={{ color: DARK, fontWeight: 600 }}>{fmt$(svcAmt)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 10 }}>
                <span style={{ color: '#666' }}>Tax</span>
                <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>
              </div>

              {/* Tip */}
              <div style={{ background: '#f8f8fc', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#666' }}>Tip</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmt$(tipAmt)}</span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {[0, 10, 15, 20, 25].map(pct => (
                    <button key={pct} onClick={() => setTipPct(pct)} style={{
                      flex: 1, padding: '5px 2px', borderRadius: 7, cursor: 'pointer', fontFamily: F, fontSize: 11,
                      border: `1.5px solid ${activeTip === pct ? BLUE : '#e8e8e8'}`,
                      background: activeTip === pct ? '#EEF0FD' : '#fff',
                      color: activeTip === pct ? BLUE : '#666', fontWeight: activeTip === pct ? 700 : 500,
                    }}>{pct === 0 ? 'None' : `${pct}%`}</button>
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

              {belowMin && (
                <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#92400E' }}>
                  {fmt$(minOrder - subtotal)} more to meet the {fmt$(minOrder)} minimum
                </div>
              )}

              {/* CTA — TODO: replace with native checkout flow */}
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

      {/* Selection bar — appears above announcement banner once a date is confirmed */}
      {hasSelection && (
        <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', boxShadow: '0 1px 0 #f0f0f0' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 12, height: 48 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <span style={{ fontSize: 13, color: '#555' }}>
                <span style={{ fontWeight: 700, color: DARK }}>{fmtDateShort(selDate)}</span>
              </span>
              {selTime && (
                <>
                  <span style={{ color: '#ddd' }}>·</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtTime(selTime)}</span>
                </>
              )}
              <span style={{ color: '#ddd' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: orderType === 'PICKUP' ? '#EEF0FD' : '#F0FDF4', color: orderType === 'PICKUP' ? INDIGO : '#166534' }}>
                {orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}
              </span>
            </div>
            <button onClick={openPicker}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', background: 'none', border: `1.5px solid #e8e8e8`, borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#555', fontFamily: F, transition: 'all 0.15s' }}>
              ✏️ Edit
            </button>
          </div>
        </div>
      )}

      {/* Announcement banner */}
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
      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '28px 24px 120px', display: 'flex', gap: 24 }}>

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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {cat.mealPackages.filter(p => p.available !== false).map(pkg => {
                    const qty = cartQty(pkg.reference)
                    const imgUrl = pkg.image?.reference ? pkgImg(pkg.image.reference, 300) : null
                    return (
                      <div key={pkg.reference} style={{
                        background: '#fff', borderRadius: 14, overflow: 'hidden',
                        border: `1.5px solid ${qty > 0 ? BLUE : '#ebebeb'}`,
                        display: 'flex', flexDirection: 'row', minHeight: 128,
                        boxShadow: qty > 0 ? '0 4px 20px rgba(91,111,232,0.12)' : '0 1px 3px rgba(0,0,0,0.05)',
                        transition: 'all 0.15s',
                      }}>
                        {/* Text content */}
                        <div style={{ flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: DARK, lineHeight: 1.3, marginBottom: 2 }}>{pkg.name}</div>
                          {pkg.serves && <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>Serves {pkg.serves}</div>}
                          {pkg.description && (
                            <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: '0 0 auto',
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            } as React.CSSProperties}>{pkg.description}</p>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 10 }}>
                            <div>
                              <span style={{ fontSize: 18, fontWeight: 800, color: BLUE }}>{fmt$(pkg.price)}</span>
                              <span style={{ fontSize: 11, fontWeight: 500, color: '#aaa' }}>/pkg</span>
                            </div>
                            {qty > 0 ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                                <button onClick={() => updateQty(pkg.reference, -1)} style={{ width: 30, height: 30, borderRadius: 8, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 16, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                                <span style={{ fontSize: 15, fontWeight: 800, color: BLUE, minWidth: 20, textAlign: 'center' }}>{qty}</span>
                                <button onClick={() => addItem(pkg)} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: BLUE, cursor: 'pointer', fontSize: 16, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                              </div>
                            ) : (
                              <button onClick={() => addItem(pkg)} style={{ padding: '7px 14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.22)', whiteSpace: 'nowrap', flexShrink: 0 }}>+ Add</button>
                            )}
                          </div>
                        </div>

                        {/* Image */}
                        <div style={{ width: 140, flexShrink: 0, position: 'relative', background: 'linear-gradient(135deg,#f4f4fb 0%,#eaeaf6 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {imgUrl
                            ? <img src={imgUrl} alt={pkg.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                onError={e => { const el = e.target as HTMLImageElement; el.style.display = 'none' }} />
                            : <span style={{ fontSize: 36, opacity: 0.4 }}>🍽️</span>
                          }
                          {qty > 0 && (
                            <div style={{ position: 'absolute', top: 8, right: 8, background: BLUE, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>{qty}</div>
                          )}
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
        <button onClick={() => setMobileCartOpen(true)} style={{ width: '100%', padding: '14px', background: cartCount > 0 ? BLUE : '#e8e8e8', color: cartCount > 0 ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: cartCount > 0 ? '0 4px 14px rgba(91,111,232,0.25)' : 'none' }}>
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

      {/* ── Date/Time Picker Modal ─────────────────────────────────────────── */}
      {pickerOpen && (
        <div onClick={closePicker}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 24, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 32px 80px rgba(0,0,0,0.22)' }}>

            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: DARK, letterSpacing: '-0.02em' }}>When do you want your order?</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 3 }}>{restaurant.name}</div>
              </div>
              <button onClick={closePicker} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>

              {/* Order type */}
              {menuAvail.length > 1 && (
                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Fulfillment Method</div>
                  <div style={{ display: 'flex', background: '#f4f4f8', borderRadius: 12, padding: 4, gap: 4 }}>
                    {(['PICKUP', 'DELIVERY'] as const).filter(t => menuAvail.includes(t)).map(type => (
                      <button key={type} onClick={() => setTempType(type)} style={{
                        flex: 1, padding: '10px 8px', border: 'none', borderRadius: 9, cursor: 'pointer',
                        background: tempType === type ? '#fff' : 'transparent',
                        color: tempType === type ? DARK : '#999', fontFamily: F, fontSize: 14,
                        fontWeight: tempType === type ? 700 : 500,
                        boxShadow: tempType === type ? '0 1px 6px rgba(0,0,0,0.1)' : 'none',
                        transition: 'all 0.15s',
                      }}>
                        {type === 'DELIVERY' ? '🚚 Delivery' : '🏃 Pickup'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Calendar */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <button onClick={prevMonth} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: DARK }}>‹</button>
                  <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{MONTH_NAMES[calMonth]} {calYear}</span>
                  <button onClick={nextMonth} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: DARK }}>›</button>
                </div>
                <MonthCalendar
                  year={calYear} month={calMonth}
                  availSet={availSet} todayIso={todayIso}
                  selDate={tempDate} onSelect={handleTempDateSelect}
                />
              </div>

              {/* Time picker */}
              {tempDate && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                    Pickup Time — {fmtDateShort(tempDate)}
                  </div>
                  {modalTimes.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#bbb', padding: '12px 0' }}>No times available on this date.</div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {modalTimes.map(t => {
                        const sel = t === tempTime
                        return (
                          <button key={t} onClick={() => setTempTime(t)} style={{
                            padding: '8px 13px', borderRadius: 9, cursor: 'pointer', fontFamily: F, fontSize: 13,
                            border: `2px solid ${sel ? BLUE : '#e8e8e8'}`,
                            background: sel ? BLUE : '#fff',
                            color: sel ? '#fff' : DARK, fontWeight: sel ? 700 : 500,
                            transition: 'all 0.12s',
                          }}>{fmtTime(t)}</button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Footer */}
              <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
                <button onClick={closePicker} style={{ flex: 1, padding: '13px', background: '#f4f4f8', color: '#555', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  {hasSelection ? 'Keep Current' : 'Skip for now'}
                </button>
                <button onClick={confirmPicker} disabled={!tempDate || !tempTime}
                  style={{
                    flex: 2, padding: '13px', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, fontFamily: F,
                    background: tempDate && tempTime ? BLUE : '#e8e8e8',
                    color: tempDate && tempTime ? '#fff' : '#bbb',
                    cursor: tempDate && tempTime ? 'pointer' : 'default',
                    boxShadow: tempDate && tempTime ? '0 4px 14px rgba(91,111,232,0.25)' : 'none',
                    transition: 'all 0.15s',
                  }}>
                  {tempDate && tempTime ? `Confirm — ${fmtDateShort(tempDate)}, ${fmtTime(tempTime)}` : 'Select a date & time'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        input:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.1) !important; }
        @media (max-width: 900px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
      `}</style>
    </div>
  )
}
