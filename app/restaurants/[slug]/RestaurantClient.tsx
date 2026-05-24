'use client'
import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'
import CheckoutDrawer from './CheckoutDrawer'

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

// Exact field names from FM API: extraItemsGroups[].addOns[]
// minSelectedItems / maxSelectedItems (NOT minSelect/maxSelect)
// subExternalName === 'Required' indicates required group
interface FmAddOn {
  reference: string; name: string; price: number; visible?: boolean; position?: number
}
interface FmExtraItemsGroup {
  reference: string; name: string
  externalName?: string        // e.g. "Select 6 Bagels"
  subExternalName?: string     // e.g. "Required"
  minSelectedItems: number     // minimum qty to select across all addOns in group
  maxSelectedItems: number     // maximum qty total
  visible?: boolean; enabled?: boolean
  addOns: FmAddOn[]
}
interface FmPackage {
  reference: string; name: string; description?: string | null
  price: number                // dollars (e.g. 14 = $14.00)
  serves?: string | number | null
  image?: { reference: string; availableResolutions?: number[] } | null
  available?: boolean
  allowedSpecialInstructions?: boolean
  extraItemsGroups?: FmExtraItemsGroup[]
  inventoryBalanceCountperTime?: number | null
}

interface FmCategory { reference: string; name: string; description?: string | null; mealPackages: FmPackage[] }
interface MenuSection { menu: FmMenu; categories: FmCategory[] }

interface Restaurant {
  name: string; address?: string; cuisine?: string; cuisines?: string[]
  description?: string; image?: any; orderUrl?: string
  isDisco?: boolean; location?: string; tags?: string[]
}

interface CartItem { pkg: FmPackage; quantity: number; note?: string }

// ── Price format — always $0.00 ────────────────────────────────────────────────
const formatPrice = (p: number) => `$${p.toFixed(2)}`

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
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) }
  catch { return t }
}
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
  // ── UI ────────────────────────────────────────────────────────────────────
  const [activeMenuIdx, setActiveMenuIdx] = useState(0)
  const [headerImgError, setHeaderImgError] = useState(false)
  const [mobileCartOpen, setMobileCartOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)

  // Add-ons modal — state: groupRef → { addOnRef → quantity }
  const [addOnsPkg, setAddOnsPkg] = useState<FmPackage | null>(null)
  const [selAddOns, setSelAddOns] = useState<Record<string, Record<string, number>>>({})
  const [addOnsNote, setAddOnsNote] = useState('')
  const [addOnsQty, setAddOnsQty] = useState(1)

  // ── Cart ──────────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartItem[]>([])
  const [tipPct, setTipPct] = useState<number | null>(null)
  const [addr, setAddr] = useState({ line1: '', city: '', state: '', zip: '' })

  // ── Order config ──────────────────────────────────────────────────────────
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [hasSelection, setHasSelection] = useState(false)

  // ── Date picker modal ─────────────────────────────────────────────────────
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

  // ── Auto-open picker on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (!fmSlug || availDates.length === 0) return
    const first = availDates[0]
    const d = new Date(first + 'T12:00:00')
    setCalYear(d.getFullYear()); setCalMonth(d.getMonth())
    setTempDate(first)
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
  function handleTempDateSelect(d: string) { setTempDate(d); setTempTime('') }
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
  if (minOrder) notices.push(`${formatPrice(minOrder)} minimum`)
  if (menuAvail.length) notices.push(menuAvail.map(t => t === 'PICKUP' ? 'Pickup' : 'Delivery').join(' & '))

  // ── Cart helpers ──────────────────────────────────────────────────────────
  const cartQty = (ref: string) => cart.find(i => i.pkg.reference === ref)?.quantity ?? 0
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0)

  const addItem = (pkg: FmPackage, note?: string) => setCart(prev => {
    const i = prev.findIndex(x => x.pkg.reference === pkg.reference)
    if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], quantity: n[i].quantity + 1 }; return n }
    return [...prev, { pkg, quantity: 1, note }]
  })
  const updateQty = (ref: string, delta: number) =>
    setCart(prev => prev.map(i => i.pkg.reference === ref ? { ...i, quantity: i.quantity + delta } : i).filter(i => i.quantity > 0))

  // ── Add-ons modal handlers ────────────────────────────────────────────────
  function handleAddClick(pkg: FmPackage) {
    const groups = pkg.extraItemsGroups ?? []
    if (groups.length > 0 || pkg.allowedSpecialInstructions) {
      setAddOnsPkg(pkg)
      // init selAddOns: each group starts with all zeros
      const init: Record<string, Record<string, number>> = {}
      groups.forEach(g => {
        const m: Record<string, number> = {}
        g.addOns.forEach(a => { m[a.reference] = 0 })
        init[g.reference] = m
      })
      setSelAddOns(init)
      setAddOnsNote('')
      setAddOnsQty(1)
    } else {
      addItem(pkg)
    }
  }

  function groupTotal(group: FmExtraItemsGroup): number {
    const m = selAddOns[group.reference] ?? {}
    return Object.values(m).reduce((s, q) => s + q, 0)
  }

  function isGroupValid(group: FmExtraItemsGroup): boolean {
    const total = groupTotal(group)
    return total >= group.minSelectedItems && total <= group.maxSelectedItems
  }

  function canConfirmAddOns(): boolean {
    if (!addOnsPkg) return false
    const groups = addOnsPkg.extraItemsGroups ?? []
    const requiredGroups = groups.filter(g => g.subExternalName === 'Required' || g.minSelectedItems > 0)
    return requiredGroups.every(g => isGroupValid(g))
  }

  function addOnsRunningPrice(): number {
    if (!addOnsPkg) return 0
    let extra = 0
    for (const group of addOnsPkg.extraItemsGroups ?? []) {
      const m = selAddOns[group.reference] ?? {}
      for (const addOn of group.addOns) {
        extra += addOn.price * (m[addOn.reference] ?? 0)
      }
    }
    return (addOnsPkg.price + extra) * addOnsQty
  }

  function confirmAddOns() {
    if (!addOnsPkg || !canConfirmAddOns()) return
    for (let i = 0; i < addOnsQty; i++) addItem(addOnsPkg, addOnsNote || undefined)
    setAddOnsPkg(null)
  }

  function setAddOnQty(groupRef: string, addOnRef: string, delta: number, max: number) {
    setSelAddOns(prev => {
      const groupMap = { ...(prev[groupRef] ?? {}) }
      const cur = groupMap[addOnRef] ?? 0
      const curTotal = Object.values(groupMap).reduce((s, q) => s + q, 0)
      if (delta > 0 && curTotal >= max) return prev // would exceed group max
      groupMap[addOnRef] = Math.max(0, cur + delta)
      return { ...prev, [groupRef]: groupMap }
    })
  }

  // ── Header image ──────────────────────────────────────────────────────────
  const headerImg = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')}`
    : null
  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []

  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 11px', border: '1.5px solid #e8e8e8',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
  }

  // ── Cart sidebar panel ────────────────────────────────────────────────────
  const cartPanel = (
    <div>
      {hasSelection ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4', background: '#fafafa' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, color: '#555' }}>
              <span style={{ fontWeight: 700 }}>{fmtDateShort(selDate)}</span>
              {selTime && <span style={{ color: '#888' }}> · {fmtTime(selTime)}</span>}
              <span style={{ color: '#888' }}> · {orderType === 'PICKUP' ? 'Pickup' : 'Delivery'}</span>
            </div>
            <button onClick={openPicker} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: '2px 6px' }}>Edit</button>
          </div>
        </div>
      ) : fmSlug ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <button onClick={openPicker} style={{ width: '100%', padding: '10px', background: '#f0f0f8', border: `1.5px dashed ${INDIGO}30`, borderRadius: 10, cursor: 'pointer', fontFamily: F, fontSize: 13, fontWeight: 600, color: INDIGO }}>
            📅 Select Date & Time
          </button>
        </div>
      ) : null}

      {hasSelection && orderType === 'DELIVERY' && (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f4f4f4' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>Delivery Address</div>
          <input value={addr.line1} onChange={e => setAddr(a => ({ ...a, line1: e.target.value }))} placeholder="Street address" style={{ ...inp, marginBottom: 5 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 68px', gap: 5 }}>
            <input value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} placeholder="City" style={inp} />
            <input value={addr.state} onChange={e => setAddr(a => ({ ...a, state: e.target.value.toUpperCase() }))} placeholder="ST" maxLength={2} style={inp} />
            <input value={addr.zip} onChange={e => setAddr(a => ({ ...a, zip: e.target.value }))} placeholder="ZIP" style={inp} />
          </div>
        </div>
      )}

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
                    {item.pkg.serves && <div style={{ fontSize: 11, color: '#bbb' }}>Serves {item.pkg.serves}</div>}
                    {item.note && <div style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', marginTop: 2 }}>{item.note}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => updateQty(item.pkg.reference, -1)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 18, textAlign: 'center' }}>{item.quantity}</span>
                    <button onClick={() => addItem(item.pkg)} style={{ width: 24, height: 24, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 14, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: DARK, minWidth: 52, textAlign: 'right' }}>{formatPrice(item.pkg.price * item.quantity)}</div>
                </div>
              ))}
            </div>

            <div style={{ paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span style={{ color: '#666' }}>Subtotal</span>
                <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(subtotal)}</span>
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
                  <span style={{ color: DARK, fontWeight: 600 }}>{formatPrice(svcAmt)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 10 }}>
                <span style={{ color: '#666' }}>Tax</span>
                <span style={{ color: '#bbb', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>
              </div>

              <div style={{ background: '#f8f8fc', borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#666' }}>Tip</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{formatPrice(tipAmt)}</span>
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

              <div style={{ borderTop: '2px solid #f0f0f0', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Total</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 18, fontWeight: 800, color: DARK }}>{formatPrice(clientTotal)}</span>
                  {orderType === 'DELIVERY' && <div style={{ fontSize: 10, color: '#bbb' }}>+ delivery & tax</div>}
                </div>
              </div>

              {belowMin && (
                <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 12, color: '#92400E' }}>
                  {formatPrice(minOrder - subtotal)} more to meet the {formatPrice(minOrder)} minimum
                </div>
              )}

              {fmRef ? (
                <button onClick={() => { if (cart.length > 0 && !belowMin) setCheckoutOpen(true) }} disabled={cart.length === 0 || belowMin}
                  style={{ width: '100%', padding: '13px', border: 'none', borderRadius: 12, background: cart.length > 0 && !belowMin ? BLUE : '#e8e8e8', color: cart.length > 0 && !belowMin ? '#fff' : '#bbb', fontSize: 14, fontWeight: 700, fontFamily: F, cursor: cart.length > 0 && !belowMin ? 'pointer' : 'default', boxShadow: cart.length > 0 && !belowMin ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
                  {cart.length === 0 ? 'Add items to order' : belowMin ? `${formatPrice(minOrder - subtotal)} more to minimum` : 'Place Order →'}
                </button>
              ) : (
                <a href={fmSlug ? `https://www.familymeal.com/disco/${fmSlug}` : '#'} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'block', textAlign: 'center', padding: '13px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none', fontFamily: F }}>
                  Order on FamilyMeal →
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Selection bar — sticky, appears once date is confirmed */}
      {hasSelection && (
        <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 52, zIndex: 150, boxShadow: '0 1px 0 #f0f0f0' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 12, height: 46 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtDateShort(selDate)}</span>
              {selTime && <><span style={{ color: '#ddd' }}>·</span><span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtTime(selTime)}</span></>}
              <span style={{ color: '#ddd' }}>·</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: orderType === 'PICKUP' ? '#EEF0FD' : '#F0FDF4', color: orderType === 'PICKUP' ? INDIGO : '#166534' }}>
                {orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}
              </span>
            </div>
            <button onClick={openPicker} style={{ padding: '6px 14px', background: 'none', border: '1.5px solid #e8e8e8', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#555', fontFamily: F }}>
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

          {/* Menu tabs */}
          <div style={{ display: 'flex', overflowX: 'auto', borderTop: '1px solid #f0f0f0' }}>
            {menuData.length > 0 ? menuData.map((s, i) => (
              <button key={s.menu.reference} onClick={() => setActiveMenuIdx(i)} style={{
                padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: activeMenuIdx === i ? 700 : 500,
                color: activeMenuIdx === i ? INDIGO : '#666',
                borderBottom: `2px solid ${activeMenuIdx === i ? INDIGO : 'transparent'}`,
                fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, transition: 'all 0.12s',
              }}>{s.menu.name}</button>
            )) : (
              <div style={{ padding: '11px 0', fontSize: 13, color: '#aaa' }}>Menu</div>
            )}
          </div>
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
              <div key={cat.reference} style={{ marginBottom: 40 }}>

                {/* Sticky category header */}
                {(activeSection.categories.length > 1 || cat.name !== activeSection.menu.name) && (
                  <div style={{ position: 'sticky', top: hasSelection ? 98 : 52, zIndex: 10, background: '#f8f8fc', padding: '10px 0 10px', marginBottom: 4 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 800, color: DARK, margin: 0, letterSpacing: '-0.01em' }}>{cat.name}</h2>
                    {cat.description && <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{cat.description}</p>}
                  </div>
                )}

                {/* 2-column package grid */}
                <div className="pkg-grid">
                  {cat.mealPackages.filter(p => p.available !== false).map(pkg => {
                    const qty = cartQty(pkg.reference)
                    const imgUrl = pkg.image?.reference ? pkgImg(pkg.image.reference, 300) : null
                    const inventory = pkg.inventoryBalanceCountperTime
                    const hasModifiers = (pkg.extraItemsGroups?.length ?? 0) > 0

                    return (
                      <div key={pkg.reference} style={{
                        background: '#fff', borderRadius: 14, overflow: 'hidden',
                        border: `1.5px solid ${qty > 0 ? BLUE : '#ebebeb'}`,
                        display: 'flex', flexDirection: 'column',
                        boxShadow: qty > 0 ? '0 4px 20px rgba(91,111,232,0.12)' : '0 1px 3px rgba(0,0,0,0.05)',
                        transition: 'all 0.15s',
                      }}>
                        {/* Image */}
                        <div style={{ height: 160, background: 'linear-gradient(135deg,#f4f4fb 0%,#eaeaf6 100%)', overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
                          {imgUrl && (
                            <img src={imgUrl} alt={pkg.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                          )}
                          {/* Inventory warning badge */}
                          {inventory != null && inventory > 0 && (
                            <div style={{ position: 'absolute', top: 8, left: 8, background: '#EF4444', color: '#fff', borderRadius: 20, fontSize: 10, fontWeight: 700, padding: '3px 8px' }}>
                              {inventory} left
                            </div>
                          )}
                          {/* Quantity badge */}
                          {qty > 0 && (
                            <div style={{ position: 'absolute', top: 8, right: 8, background: BLUE, color: '#fff', borderRadius: '50%', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>{qty}</div>
                          )}
                        </div>

                        {/* Text */}
                        <div style={{ padding: '14px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ fontSize: 14, fontWeight: 800, color: DARK, marginBottom: 2, lineHeight: 1.3 }}>{pkg.name}</div>
                          {pkg.serves && <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Serves {pkg.serves}</div>}
                          {pkg.description && (
                            <p style={{ fontSize: 12, color: '#666', lineHeight: 1.5, margin: '0 0 10px', flex: 1,
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            } as React.CSSProperties}>{pkg.description}</p>
                          )}

                          {/* Price + action */}
                          <div style={{ marginTop: 'auto', paddingTop: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hasModifiers ? 8 : 0 }}>
                              <div style={{ fontSize: 17, fontWeight: 800, color: BLUE }}>
                                {formatPrice(pkg.price)}<span style={{ fontSize: 11, fontWeight: 500, color: '#888' }}>/pkg</span>
                              </div>
                              {qty > 0 && !hasModifiers ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <button onClick={() => updateQty(pkg.reference, -1)} style={{ width: 28, height: 28, borderRadius: 7, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 15, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                                  <span style={{ fontSize: 14, fontWeight: 800, color: BLUE, minWidth: 20, textAlign: 'center' }}>{qty}</span>
                                  <button onClick={() => addItem(pkg)} style={{ width: 28, height: 28, borderRadius: 7, border: 'none', background: BLUE, cursor: 'pointer', fontSize: 15, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                                </div>
                              ) : null}
                            </div>

                            {/* Add to Order button — shown when no qty yet, or when has modifiers */}
                            {(qty === 0 || hasModifiers) && (
                              <button onClick={() => handleAddClick(pkg)}
                                style={{ width: '100%', padding: '9px', background: BLUE, color: '#fff', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 2px 8px rgba(91,111,232,0.22)' }}>
                                {hasModifiers && qty > 0 ? `Add another (+${formatPrice(pkg.price)})` : 'Add to Order'}
                              </button>
                            )}

                            {/* Special instructions link */}
                            {pkg.allowedSpecialInstructions && qty > 0 && !hasModifiers && (
                              <button onClick={() => handleAddClick(pkg)}
                                style={{ display: 'block', width: '100%', textAlign: 'center', marginTop: 6, fontSize: 11, color: '#888', background: 'none', border: 'none', cursor: 'pointer', fontFamily: F, textDecoration: 'underline' }}>
                                Add a note
                              </button>
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
          <div style={{ position: 'sticky', top: hasSelection ? 106 : 68, background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', boxShadow: '0 4px 24px rgba(0,0,0,0.06)', maxHeight: 'calc(100vh - 90px)', overflowY: 'auto' }}>
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
          {cartCount > 0 ? `${cartCount} item${cartCount !== 1 ? 's' : ''} · ${formatPrice(subtotal)} — View Order` : 'Browse Menu → Start Order'}
        </button>
      </div>

      {mobileCartOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
            <div><div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div><div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div></div>
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

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 24px 0' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800, color: DARK, letterSpacing: '-0.02em' }}>When do you want your order?</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 3 }}>{restaurant.name}</div>
              </div>
              <button onClick={closePicker} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 34, height: 34, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
            </div>

            <div style={{ padding: '20px 24px 24px' }}>
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
                        boxShadow: tempType === type ? '0 1px 6px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s',
                      }}>
                        {type === 'DELIVERY' ? '🚚 Delivery' : '🏃 Pickup'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <button onClick={prevMonth} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: DARK }}>‹</button>
                  <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>{MONTH_NAMES[calMonth]} {calYear}</span>
                  <button onClick={nextMonth} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: DARK }}>›</button>
                </div>
                <MonthCalendar year={calYear} month={calMonth} availSet={availSet} todayIso={todayIso} selDate={tempDate} onSelect={handleTempDateSelect} />
              </div>

              {tempDate && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                    {tempType === 'PICKUP' ? 'Pickup' : 'Delivery'} Time — {fmtDateShort(tempDate)}
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
                            color: sel ? '#fff' : DARK, fontWeight: sel ? 700 : 500, transition: 'all 0.12s',
                          }}>{fmtTime(t)}</button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
                <button onClick={closePicker} style={{ flex: 1, padding: '13px', background: '#f4f4f8', color: '#555', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                  {hasSelection ? 'Keep Current' : 'Skip for now'}
                </button>
                <button onClick={confirmPicker} disabled={!tempDate || !tempTime}
                  style={{ flex: 2, padding: '13px', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, fontFamily: F, background: tempDate && tempTime ? BLUE : '#e8e8e8', color: tempDate && tempTime ? '#fff' : '#bbb', cursor: tempDate && tempTime ? 'pointer' : 'default', boxShadow: tempDate && tempTime ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
                  {tempDate && tempTime ? `Confirm — ${fmtDateShort(tempDate)}, ${fmtTime(tempTime)}` : 'Select a date & time'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Checkout Drawer ────────────────────────────────────────────── */}
      {checkoutOpen && fmRef && (
        <CheckoutDrawer
          fmRef={fmRef} fmSlug={fmSlug} restaurantName={restaurant.name}
          cart={cart} selDate={selDate} selTime={selTime} orderType={orderType}
          addr={addr} subtotal={subtotal} tipAmt={tipAmt} svcAmt={svcAmt} minOrder={minOrder}
          onClose={() => setCheckoutOpen(false)}
        />
      )}

      {/* ── Add-ons / Modifiers Modal ─────────────────────────────────── */}
      {addOnsPkg && (
        <div onClick={() => setAddOnsPkg(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.22)' }}>

            {/* Modal header with image */}
            {addOnsPkg.image?.reference && (
              <div style={{ height: 140, background: 'linear-gradient(135deg,#f4f4fb,#eaeaf6)', overflow: 'hidden', borderRadius: '20px 20px 0 0', flexShrink: 0 }}>
                <img src={pkgImg(addOnsPkg.image.reference, 550)} alt={addOnsPkg.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
              </div>
            )}

            <div style={{ padding: '18px 22px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 800, color: DARK, letterSpacing: '-0.02em' }}>{addOnsPkg.name}</div>
                <div style={{ fontSize: 13, color: '#888', marginTop: 2 }}>{formatPrice(addOnsPkg.price)} per package</div>
              </div>
              <button onClick={() => setAddOnsPkg(null)} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 12 }}>×</button>
            </div>

            {/* Scrollable body */}
            <div style={{ overflowY: 'auto', padding: '16px 22px', flex: 1 }}>
              {/* Extra items groups — quantity selectors per addOn */}
              {(addOnsPkg.extraItemsGroups ?? []).map(group => {
                const total = groupTotal(group)
                const isRequired = group.subExternalName === 'Required' || group.minSelectedItems > 0
                const isFull = total >= group.maxSelectedItems
                const isValid = isGroupValid(group)

                return (
                  <div key={group.reference} style={{ marginBottom: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{group.externalName || group.name}</span>
                        {isRequired && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#C044C8' }}>Required</span>}
                      </div>
                      <span style={{ fontSize: 12, color: isValid ? '#22C55E' : '#aaa', fontWeight: 600 }}>
                        {total} of {group.maxSelectedItems} selected
                      </span>
                    </div>
                    {group.minSelectedItems > 0 && (
                      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
                        Select {group.minSelectedItems === group.maxSelectedItems ? `exactly ${group.minSelectedItems}` : `${group.minSelectedItems}–${group.maxSelectedItems}`}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {group.addOns.map(addOn => {
                        const qty = selAddOns[group.reference]?.[addOn.reference] ?? 0
                        return (
                          <div key={addOn.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${qty > 0 ? BLUE : '#e8e8e8'}`, background: qty > 0 ? '#EEF0FD' : '#fff', transition: 'all 0.12s' }}>
                            <div>
                              <span style={{ fontSize: 14, color: DARK, fontWeight: qty > 0 ? 600 : 400 }}>{addOn.name}</span>
                              {addOn.price > 0 && <span style={{ fontSize: 12, color: BLUE, fontWeight: 700, marginLeft: 8 }}>+{formatPrice(addOn.price)}</span>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              {qty > 0 && (
                                <button onClick={() => setAddOnQty(group.reference, addOn.reference, -1, group.maxSelectedItems)}
                                  style={{ width: 26, height: 26, borderRadius: 7, border: `1.5px solid ${BLUE}`, background: '#fff', cursor: 'pointer', fontSize: 14, color: BLUE, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                              )}
                              {qty > 0 && <span style={{ fontSize: 14, fontWeight: 800, color: BLUE, minWidth: 18, textAlign: 'center' }}>{qty}</span>}
                              <button onClick={() => { if (!isFull) setAddOnQty(group.reference, addOn.reference, 1, group.maxSelectedItems) }}
                                disabled={isFull}
                                style={{ width: 26, height: 26, borderRadius: 7, border: 'none', background: isFull ? '#f0f0f0' : BLUE, cursor: isFull ? 'default' : 'pointer', fontSize: 14, color: isFull ? '#bbb' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {/* Special instructions */}
              {addOnsPkg.allowedSpecialInstructions && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 6 }}>Special Instructions</div>
                  <textarea value={addOnsNote} onChange={e => setAddOnsNote(e.target.value)}
                    placeholder="Allergies, dietary restrictions, requests…"
                    rows={3}
                    style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 13, fontFamily: F, color: DARK, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Quantity selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: DARK }}>Quantity</span>
                <button onClick={() => setAddOnsQty(q => Math.max(1, q - 1))} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>−</button>
                <span style={{ fontSize: 15, fontWeight: 700, color: DARK, minWidth: 24, textAlign: 'center' }}>{addOnsQty}</span>
                <button onClick={() => setAddOnsQty(q => q + 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: F }}>+</button>
              </div>
            </div>

            {/* Modal footer */}
            <div style={{ padding: '14px 22px', borderTop: '1px solid #f0f0f0', flexShrink: 0 }}>
              <button onClick={confirmAddOns} disabled={!canConfirmAddOns()}
                style={{ width: '100%', padding: '13px', background: canConfirmAddOns() ? BLUE : '#e8e8e8', color: canConfirmAddOns() ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: canConfirmAddOns() ? 'pointer' : 'default', fontFamily: F, boxShadow: canConfirmAddOns() ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
                Add to Order — {formatPrice(addOnsRunningPrice())}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .pkg-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        input:focus, textarea:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.1) !important; }
        @media (max-width: 900px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
        @media (max-width: 600px) {
          .pkg-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )
}
