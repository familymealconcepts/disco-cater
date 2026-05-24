'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'

interface Package {
  reference: string
  name: string
  description?: string
  price: number
  serves?: number
  image?: string
  minimumOrderAmount?: number
  advanceNoticeHours?: number
  orderTypes?: string[]
}
interface MenuItem { name: string; description?: string; price?: number; image?: string }
interface MenuCategory { name: string; items?: MenuItem[]; menuItems?: MenuItem[] }
interface Restaurant {
  name: string; address: string; cuisine: string; cuisines?: string[]
  description: string; image?: any; orderUrl: string; isDisco: boolean
  location: string; tags?: string[]
}
interface Addr { line1: string; city: string; state: string; zipCode: string }
interface OrderItem { pkg: Package; headcount: number; instructions: string }

declare global { interface Window { Stripe?: (key: string) => any } }

function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) }
  catch { return d }
}
function fmtDateParts(d: string) {
  try {
    const obj = new Date(d + 'T12:00:00')
    return { wday: obj.toLocaleDateString('en-US', { weekday: 'short' }), mday: obj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  } catch { return { wday: '', mday: d } }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) }
  catch { return t }
}

export default function RestaurantClient({
  restaurant, restaurantRef, slug,
}: {
  restaurant: Restaurant
  restaurantRef: string | null
  slug: string
}) {
  // ── Data ─────────────────────────────────────────────────────────────────
  const [packages, setPackages] = useState<Package[]>([])
  const [categories, setCategories] = useState<MenuCategory[]>([])
  const [banner, setBanner] = useState<{ advanceHours?: number; minAmount?: number; orderTypes?: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [imgError, setImgError] = useState(false)
  const [activeTab, setActiveTab] = useState('Catering Packages')

  // ── Order config ──────────────────────────────────────────────────────────
  const [orderItem, setOrderItem] = useState<OrderItem | null>(null)
  const [orderType, setOrderType] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY')
  const [addr, setAddr] = useState<Addr>({ line1: '', city: '', state: '', zipCode: '' })
  const [dates, setDates] = useState<string[]>([])
  const [times, setTimes] = useState<string[]>([])
  const [selDate, setSelDate] = useState('')
  const [selTime, setSelTime] = useState('')
  const [datesLoading, setDatesLoading] = useState(false)
  const [timesLoading, setTimesLoading] = useState(false)

  // ── Add-to-order modal ────────────────────────────────────────────────────
  const [addModal, setAddModal] = useState<Package | null>(null)
  const [addHeadcount, setAddHeadcount] = useState(10)
  const [addInstructions, setAddInstructions] = useState('')

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [user, setUser] = useState<any>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // ── Order flow ────────────────────────────────────────────────────────────
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [orderRef, setOrderRef] = useState('')
  const [totals, setTotals] = useState<any>(null)

  // ── Payment modal ─────────────────────────────────────────────────────────
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [savedCard, setSavedCard] = useState<any>(null)
  const [stripeKey, setStripeKey] = useState('')
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  // ── Confirmation ──────────────────────────────────────────────────────────
  const [orderDone, setOrderDone] = useState(false)
  const [confirmation, setConfirmation] = useState<any>(null)

  // ── Mobile ────────────────────────────────────────────────────────────────
  const [mobileOrderOpen, setMobileOrderOpen] = useState(false)

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    try { const s = localStorage.getItem('disco_user'); if (s) setUser(JSON.parse(s)) } catch {}
  }, [])

  useEffect(() => {
    if (!restaurantRef) { setLoading(false); return }

    fetch(`/api/fm-packages?ref=${restaurantRef}`)
      .then(r => r.json())
      .then((data: any) => {
        console.log('[fm-packages]', data)
        const pkgs: Package[] = Array.isArray(data) ? data : []
        setPackages(pkgs)
        const allTypes = [...new Set(pkgs.flatMap((p: any) => p.orderTypes ?? []))] as string[]
        const first: any = pkgs[0] ?? {}
        const b: any = {}
        if (first.advanceNoticeHours) b.advanceHours = first.advanceNoticeHours
        if (first.minimumOrderAmount) b.minAmount = first.minimumOrderAmount
        if (allTypes.length) b.orderTypes = allTypes
        if (Object.keys(b).length) setBanner(b)
        setLoading(false)
      })
      .catch(() => setLoading(false))

    fetch(`/api/fm-menu?ref=${restaurantRef}`)
      .then(r => r.json())
      .then((data: any) => {
        console.log('[fm-menu]', data)
        let cats: MenuCategory[] = []
        if (Array.isArray(data?.categories)) cats = data.categories
        else if (Array.isArray(data?.menuCategories)) cats = data.menuCategories
        else if (Array.isArray(data)) cats = data
        cats = cats
          .map(c => ({ ...c, items: c.items ?? (c as any).menuItems ?? [] }))
          .filter(c => !['Catering Packages', 'Catering Menu'].includes(c.name))
        setCategories(cats)
        if (data?.minimumOrderAmount || data?.advanceNoticeHours) {
          setBanner(prev => ({
            ...prev,
            ...(data.advanceNoticeHours ? { advanceHours: data.advanceNoticeHours } : {}),
            ...(data.minimumOrderAmount ? { minAmount: data.minimumOrderAmount } : {}),
          }))
        }
      })
      .catch(() => {})
  }, [restaurantRef])

  // Fetch dates when package selected
  const pkgRef = orderItem?.pkg?.reference ?? null
  useEffect(() => {
    if (!pkgRef) return
    setDatesLoading(true); setDates([]); setSelDate(''); setTimes([]); setSelTime('')
    fetch(`/api/fm-dates?packageRef=${pkgRef}`)
      .then(r => r.json())
      .then((d: any) => {
        console.log('[fm-dates]', d)
        const arr: any[] = Array.isArray(d) ? d : d?.dates ?? d?.availableDates ?? []
        setDates(arr.map((x: any) => typeof x === 'string' ? x : x.date || x.localDate || '').filter(Boolean))
        setDatesLoading(false)
      })
      .catch(() => setDatesLoading(false))
  }, [pkgRef])

  // Fetch times when date selected
  useEffect(() => {
    if (!pkgRef || !selDate) return
    setTimesLoading(true); setTimes([]); setSelTime('')
    fetch(`/api/fm-times?packageRef=${pkgRef}&date=${selDate}`)
      .then(r => r.json())
      .then((d: any) => {
        console.log('[fm-times]', d)
        const arr: any[] = Array.isArray(d) ? d : d?.times ?? d?.availableTimes ?? d?.pickUpTimes ?? []
        setTimes(arr.map((x: any) => typeof x === 'string' ? x : x.time || x.localTime || '').filter(Boolean))
        setTimesLoading(false)
      })
      .catch(() => setTimesLoading(false))
  }, [pkgRef, selDate])

  // Load Stripe + saved card when payment modal opens
  useEffect(() => {
    if (!paymentOpen || !user) return
    fetch('/api/order/stripe-info', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(r => r.json())
      .then((d: any) => {
        console.log('[stripe-info]', d)
        setStripeKey(d.publishableKey || d.publicKey || d.stripePublishableKey || d.key || '')
      })
      .catch(() => {})
    fetch('/api/order/saved-card', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(r => r.json())
      .then((d: any) => {
        console.log('[saved-card]', d)
        if (d && !d.error && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setSavedCard(d)
      })
      .catch(() => {})
  }, [paymentOpen, user])

  // Mount Stripe card element
  useEffect(() => {
    if (!paymentOpen || !stripeKey || savedCard || !cardRef.current) return
    const mount = () => {
      if (!window.Stripe || !cardRef.current || cardElRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      cardElRef.current = stripeRef.current.elements().create('card', {
        style: { base: { fontFamily: F, fontSize: '16px', color: DARK, '::placeholder': { color: '#bbb' } } },
      })
      cardElRef.current.mount(cardRef.current)
    }
    if (window.Stripe) mount()
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    }
    return () => { if (cardElRef.current) { cardElRef.current.destroy(); cardElRef.current = null } }
  }, [paymentOpen, stripeKey, savedCard])

  // ── Handlers ──────────────────────────────────────────────────────────────
  function openAddModal(pkg: Package) {
    setAddModal(pkg); setAddHeadcount(orderItem?.headcount ?? 10); setAddInstructions(orderItem?.instructions ?? '')
  }

  function confirmAdd() {
    if (!addModal) return
    setOrderItem({ pkg: addModal, headcount: addHeadcount, instructions: addInstructions })
    setAddModal(null)
    if (banner?.orderTypes?.length) setOrderType(banner.orderTypes.includes('DELIVERY') ? 'DELIVERY' : 'PICKUP')
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setLoginLoading(true); setLoginError('')
    try {
      const res = await fetch('/api/fm-auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPw }),
      })
      const data = await res.json()
      console.log('[fm-auth]', { ...data, authorization: data.authorization ? '[redacted]' : undefined })
      if (!res.ok || data.error) { setLoginError(data.error || 'Invalid email or password.'); setLoginLoading(false); return }
      localStorage.setItem('disco_user', JSON.stringify(data))
      setUser(data); setLoginLoading(false); setLoginOpen(false)
      startOrderFlow(data)
    } catch { setLoginError('Unable to connect. Please try again.'); setLoginLoading(false) }
  }

  function handlePlaceOrder() {
    if (!canPlaceOrder) return
    setOrderError('')
    if (!user) { setLoginOpen(true); return }
    startOrderFlow(user)
  }

  async function startOrderFlow(u: any) {
    if (!orderItem || !selDate || !selTime || !restaurantRef) return
    setOrderLoading(true); setOrderError('')
    try {
      const initRes = await fetch('/api/fm-order-init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantRef,
          mealPackageReference: orderItem.pkg.reference,
          localDate: selDate,
          localTime: selTime,
          persons: orderItem.headcount,
          orderType,
          ...(orderItem.instructions ? { specialInstructions: orderItem.instructions } : {}),
        }),
      })
      const initData = await initRes.json()
      console.log('[fm-order-init]', initData)
      if (!initRes.ok || initData.error) {
        setOrderError(initData.error || initData.message || 'Failed to create order. Please try again.')
        setOrderLoading(false); return
      }
      const ref = initData.reference || initData.orderReference || initData.orderRef || initData.id || initData.ref || ''
      if (!ref) { setOrderError('Order started but no reference returned.'); setOrderLoading(false); return }
      setOrderRef(ref)

      if (orderType === 'DELIVERY' && addr.line1) {
        await fetch('/api/order/validate-address', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deliveryAddress: addr }),
        }).catch(() => {})
      }

      const updRes = await fetch('/api/order/update', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantRef, orderRef: ref,
          ...(orderType === 'DELIVERY' ? { deliveryAddress: addr } : {}),
          persons: orderItem.headcount,
        }),
      })
      const updData = await updRes.json()
      console.log('[order/update]', updData)
      if (updRes.ok && !updData.error) setTotals(updData)

      setOrderLoading(false)
      setPaymentOpen(true)
    } catch {
      setOrderError('Something went wrong. Please try again.')
      setOrderLoading(false)
    }
  }

  async function handleConfirmPayment() {
    if (!user || !orderRef || !restaurantRef) return
    setPaymentLoading(true); setPaymentError('')
    try {
      let token: string | null = null
      if (!savedCard) {
        if (!stripeRef.current || !cardElRef.current) {
          setPaymentError('Payment form not ready. Please wait a moment.'); setPaymentLoading(false); return
        }
        const result = await stripeRef.current.createToken(cardElRef.current)
        if (result.error) { setPaymentError(result.error.message || 'Card error.'); setPaymentLoading(false); return }
        token = result.token?.id ?? null
      }

      const confRes = await fetch('/api/order/confirm-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ orderReference: orderRef, token, useDefaultPayment: !!savedCard, restaurantReference: restaurantRef }),
      })
      const confData = await confRes.json()
      console.log('[confirm-payment]', confData)
      if (!confRes.ok && confData.error) { setPaymentError(confData.error || 'Payment failed.'); setPaymentLoading(false); return }

      const placeRes = await fetch('/api/fm-order-place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ restaurantRef, orderRef }),
      })
      const placeData = await placeRes.json()
      console.log('[fm-order-place]', placeData)
      if (!placeRes.ok && placeData.error) { setPaymentError(placeData.error || 'Failed to place order.'); setPaymentLoading(false); return }

      setConfirmation(placeData)
      setPaymentLoading(false); setPaymentOpen(false); setOrderDone(true)
    } catch {
      setPaymentError('Something went wrong. Please try again.')
      setPaymentLoading(false)
    }
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  const imageUrl = restaurant.image?.asset?._ref
    ? `https://cdn.sanity.io/images/0j4eqnmw/production/${restaurant.image.asset._ref.replace(/^image-/, '').replace(/-([a-z]+)$/, '.$1')}`
    : null

  const tags = restaurant.cuisines?.length ? restaurant.cuisines : restaurant.cuisine ? [restaurant.cuisine] : []
  const allTabs = ['Catering Packages', ...categories.map(c => c.name)]

  const bannerParts: string[] = []
  if (banner?.advanceHours) bannerParts.push(`${banner.advanceHours} hour notice`)
  if (banner?.minAmount) bannerParts.push(`$${Math.round(banner.minAmount / 100)} order minimum`)
  if (banner?.orderTypes?.length) {
    const labels = banner.orderTypes.map(t => t === 'PICKUP' ? 'Pickup' : t === 'DELIVERY' ? 'Delivery' : t)
    bannerParts.push(labels.join(' & ') + ' available')
  }

  const canPlaceOrder = !!(
    orderItem && selDate && selTime &&
    (orderType === 'PICKUP' || (addr.line1 && addr.city && addr.state && addr.zipCode))
  )

  const estSubtotal = orderItem ? orderItem.pkg.price * orderItem.headcount : 0
  const dispSubtotal = totals?.subTotal ?? totals?.subtotal ?? totals?.totalCost ?? estSubtotal
  const dispDelivery = totals?.deliveryFee ?? totals?.delivery ?? 0
  const dispTax = totals?.tax ?? totals?.taxAmount ?? 0
  const dispTotal = totals?.total ?? totals?.totalAmount ?? (dispSubtotal + dispDelivery + dispTax)

  const activeCatItems: MenuItem[] = activeTab !== 'Catering Packages'
    ? (categories.find(c => c.name === activeTab)?.items ?? [])
    : []

  const inputSt: React.CSSProperties = {
    width: '100%', padding: '9px 11px', border: '1.5px solid #e8e8e8',
    borderRadius: 8, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box',
  }

  // ── Sidebar body (rendered in both desktop sidebar & mobile overlay) ───────
  const confirmationBody = (
    <div style={{ padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🎉</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: DARK, marginBottom: 6 }}>Order Confirmed!</div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
        {orderItem?.pkg.name}
      </div>
      <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>
        {selDate ? fmtDate(selDate) : ''}{selTime ? ` · ${fmtTime(selTime)}` : ''}
      </div>
      {(confirmation?.reference || confirmation?.orderReference || orderRef) && (
        <div style={{ fontSize: 12, color: '#bbb', marginBottom: 20 }}>
          Order #{confirmation?.reference || confirmation?.orderReference || orderRef}
        </div>
      )}
      <Link href="/portal"
        style={{ display: 'block', background: BLUE, color: '#fff', padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none', marginBottom: 10, boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
        View My Orders
      </Link>
      <Link href="/fullmap"
        style={{ display: 'block', background: '#f0f0f0', color: DARK, padding: '12px', borderRadius: 10, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
        Browse More
      </Link>
    </div>
  )

  const orderConfigBody = (
    <div style={{ padding: 20 }}>
      {/* Empty state */}
      {!orderItem && (
        <div style={{ textAlign: 'center', padding: '12px 0 20px', color: '#aaa', fontSize: 13, lineHeight: 1.6 }}>
          {restaurantRef
            ? 'Browse the menu and click Add to Order to get started'
            : 'Contact the restaurant to discuss catering options'}
        </div>
      )}

      {/* Selected package row */}
      {orderItem && (
        <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: DARK, flex: 1, lineHeight: 1.3 }}>{orderItem.pkg.name}</div>
            <button onClick={() => { setOrderItem(null); setSelDate(''); setSelTime('') }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', fontSize: 20, lineHeight: 1, padding: '0 0 0 8px', flexShrink: 0 }}>×</button>
          </div>
          {/* Headcount */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button onClick={() => setOrderItem(i => i ? { ...i, headcount: Math.max(1, i.headcount - 1) } : null)}
              style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
            <span style={{ fontSize: 14, fontWeight: 700, color: DARK, minWidth: 24, textAlign: 'center' }}>{orderItem.headcount}</span>
            <button onClick={() => setOrderItem(i => i ? { ...i, headcount: i.headcount + 1 } : null)}
              style={{ width: 26, height: 26, borderRadius: 6, border: '1.5px solid #e8e8e8', background: '#fff', cursor: 'pointer', fontSize: 16, color: DARK, fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
            <span style={{ fontSize: 12, color: '#888' }}>guests × ${(orderItem.pkg.price / 100).toFixed(2)}/pp</span>
          </div>
          {orderItem.instructions && (
            <div style={{ fontSize: 11, color: '#aaa', fontStyle: 'italic', marginBottom: 4 }}>"{orderItem.instructions}"</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: DARK }}>
            <span>Subtotal</span>
            <span>${(orderItem.pkg.price * orderItem.headcount / 100).toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Order type toggle */}
      {orderItem && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#999', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Order Type</div>
          <div style={{ display: 'flex', background: '#f4f4f4', borderRadius: 9, padding: 3, gap: 3 }}>
            {(['DELIVERY', 'PICKUP'] as const).map(type => (
              <button key={type} onClick={() => setOrderType(type)}
                style={{
                  flex: 1, padding: '7px 6px', border: 'none', borderRadius: 7, cursor: 'pointer',
                  background: orderType === type ? '#fff' : 'transparent',
                  color: orderType === type ? DARK : '#999',
                  fontFamily: F, fontSize: 12, fontWeight: orderType === type ? 700 : 500,
                  boxShadow: orderType === type ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.15s',
                }}>
                {type === 'DELIVERY' ? '🚚 Delivery' : '🏃 Pickup'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Date picker */}
      {orderItem && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#999', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Date</div>
          {datesLoading
            ? <div style={{ color: '#ccc', fontSize: 12 }}>Loading dates…</div>
            : dates.length === 0
            ? <div style={{ color: '#ccc', fontSize: 12 }}>No dates available for this package.</div>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {dates.map(d => {
                  const { wday, mday } = fmtDateParts(d)
                  const sel = d === selDate
                  return (
                    <button key={d} onClick={() => setSelDate(d)}
                      style={{ padding: '5px 9px', borderRadius: 7, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`, background: sel ? '#EEF0FD' : '#fff', cursor: 'pointer', fontFamily: F, textAlign: 'center', transition: 'all 0.1s' }}>
                      <div style={{ fontSize: 9, color: sel ? INDIGO : '#ccc', marginBottom: 1 }}>{wday}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: sel ? BLUE : DARK }}>{mday}</div>
                    </button>
                  )
                })}
              </div>
            )}
        </div>
      )}

      {/* Time picker */}
      {orderItem && selDate && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#999', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Time</div>
          {timesLoading
            ? <div style={{ color: '#ccc', fontSize: 12 }}>Loading times…</div>
            : times.length === 0
            ? <div style={{ color: '#ccc', fontSize: 12 }}>No times available for this date.</div>
            : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {times.map(t => {
                  const sel = t === selTime
                  return (
                    <button key={t} onClick={() => setSelTime(t)}
                      style={{ padding: '6px 9px', borderRadius: 7, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`, background: sel ? '#EEF0FD' : '#fff', color: sel ? BLUE : DARK, fontFamily: F, fontSize: 11, fontWeight: sel ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s' }}>
                      {fmtTime(t)}
                    </button>
                  )
                })}
              </div>
            )}
        </div>
      )}

      {/* Delivery address */}
      {orderItem && orderType === 'DELIVERY' && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#999', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Delivery Address</div>
          <input value={addr.line1} onChange={e => setAddr(a => ({ ...a, line1: e.target.value }))}
            placeholder="Street address" style={{ ...inputSt, marginBottom: 5 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 44px 68px', gap: 5 }}>
            <input value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} placeholder="City" style={inputSt} />
            <input value={addr.state} onChange={e => setAddr(a => ({ ...a, state: e.target.value.toUpperCase() }))} placeholder="ST" style={inputSt} maxLength={2} />
            <input value={addr.zipCode} onChange={e => setAddr(a => ({ ...a, zipCode: e.target.value }))} placeholder="ZIP" style={inputSt} />
          </div>
        </div>
      )}

      {/* Error */}
      {orderError && (
        <div style={{ background: '#FEF2F2', border: '1.5px solid #FCA5A5', borderRadius: 8, padding: '9px 12px', marginBottom: 12, color: '#991B1B', fontSize: 12 }}>
          {orderError}
        </div>
      )}

      {/* Place Order button */}
      <button onClick={handlePlaceOrder} disabled={!canPlaceOrder || orderLoading}
        style={{
          width: '100%', padding: '13px', background: BLUE, color: '#fff', border: 'none',
          borderRadius: 12, fontSize: 14, fontWeight: 700,
          cursor: canPlaceOrder && !orderLoading ? 'pointer' : 'not-allowed',
          fontFamily: F, opacity: canPlaceOrder && !orderLoading ? 1 : 0.4,
          boxShadow: canPlaceOrder ? '0 4px 14px rgba(91,111,232,0.25)' : 'none',
        }}>
        {orderLoading ? 'Preparing Order…' : !user ? 'Log In to Order →' : 'Place Order →'}
      </button>

      {/* Hints */}
      {orderItem && !selDate && !datesLoading && dates.length > 0 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#ccc', marginTop: 8 }}>Select a date to continue</div>
      )}
      {orderItem && selDate && !selTime && !timesLoading && times.length > 0 && (
        <div style={{ textAlign: 'center', fontSize: 11, color: '#ccc', marginTop: 8 }}>Select a time to continue</div>
      )}
    </div>
  )

  const sidebarContent = orderDone ? confirmationBody : orderConfigBody

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Dynamic info banner */}
      {bannerParts.length > 0 && (
        <div style={{ background: DARK, color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: 500, textAlign: 'center', padding: '8px 16px', letterSpacing: '0.02em' }}>
          {bannerParts.join('  ·  ')}
        </div>
      )}

      {/* Restaurant header + tabs */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px 0' }}>
          <Link href="/fullmap" style={{ fontSize: 12, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 16 }}>
            ← Back to Catering Map
          </Link>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', flexShrink: 0, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
              {imageUrl && !imgError
                ? <img src={imageUrl} alt={restaurant.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={() => setImgError(true)} />
                : '🍽️'}
            </div>
            <div style={{ flex: 1 }}>
              {restaurant.isDisco && (
                <div style={{ display: 'inline-block', background: GRAD, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 20, marginBottom: 6, letterSpacing: '0.05em' }}>
                  🪩 PREMIUM
                </div>
              )}
              <h1 style={{ fontSize: 24, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{restaurant.name}</h1>
              <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>📍 {restaurant.location || restaurant.address}</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {tags.map(t => <span key={t} style={{ background: '#f0f0f0', color: '#555', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
                {restaurant.tags?.map(t => <span key={t} style={{ background: '#EEEDFE', color: '#3C3489', fontSize: 11, padding: '2px 9px', borderRadius: 20, fontWeight: 500 }}>{t}</span>)}
              </div>
            </div>
          </div>
          {!loading && allTabs.length > 0 && (
            <div style={{ display: 'flex', overflowX: 'auto', borderTop: '1px solid #f0f0f0' }}>
              {allTabs.map(tab => (
                <button key={tab} onClick={() => setActiveTab(tab)}
                  style={{
                    padding: '11px 18px', background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: activeTab === tab ? 700 : 500,
                    color: activeTab === tab ? INDIGO : '#666',
                    borderBottom: `2px solid ${activeTab === tab ? INDIGO : 'transparent'}`,
                    fontFamily: F, whiteSpace: 'nowrap', flexShrink: 0, transition: 'color 0.15s',
                  }}>
                  {tab}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 100px', display: 'flex', gap: 28, alignItems: 'flex-start' }}>

        {/* Left: menu */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3].map(i => <div key={i} style={{ height: 120, background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', animation: 'pulse 1.5s infinite' }} />)}
            </div>
          )}

          {/* Catering Packages tab */}
          {!loading && activeTab === 'Catering Packages' && (
            packages.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '56px 0' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🍽️</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: '#888', marginBottom: 8 }}>Menu details coming soon</div>
                <div style={{ fontSize: 14, color: '#aaa' }}>Contact the restaurant directly to discuss catering options</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {packages.map(pkg => {
                  const isSelected = orderItem?.pkg.reference === pkg.reference
                  return (
                    <div key={pkg.reference}
                      style={{ background: '#fff', borderRadius: 14, border: `1.5px solid ${isSelected ? BLUE : '#f0f0f0'}`, overflow: 'hidden', display: 'flex', transition: 'box-shadow 0.15s' }}
                      onMouseOver={e => (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.07)'}
                      onMouseOut={e => (e.currentTarget as HTMLElement).style.boxShadow = 'none'}
                    >
                      {pkg.image && <img src={pkg.image} alt={pkg.name} style={{ width: 130, height: 130, objectFit: 'cover', flexShrink: 0 }} />}
                      <div style={{ flex: 1, padding: '18px 20px', display: 'flex', gap: 16, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 3 }}>{pkg.name}</div>
                          {pkg.serves && <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Serves {pkg.serves}</div>}
                          {pkg.description && <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: 0 }}>{pkg.description}</p>}
                        </div>
                        <div style={{ flexShrink: 0, textAlign: 'right' }}>
                          <div style={{ fontSize: 18, fontWeight: 800, color: DARK, marginBottom: 10 }}>
                            ${(pkg.price / 100).toFixed(2)}<span style={{ fontSize: 11, fontWeight: 400, color: '#888' }}>/pp</span>
                          </div>
                          {restaurantRef && (
                            <button onClick={() => openAddModal(pkg)}
                              style={{
                                background: isSelected ? '#EEF0FD' : BLUE,
                                color: isSelected ? BLUE : '#fff',
                                border: isSelected ? `1.5px solid ${BLUE}` : 'none',
                                padding: '9px 16px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                                cursor: 'pointer', fontFamily: F,
                                boxShadow: isSelected ? 'none' : '0 2px 8px rgba(91,111,232,0.25)',
                                whiteSpace: 'nowrap',
                              }}>
                              {isSelected ? '✓ In Order' : 'Add to Order'}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          )}

          {/* Other category tabs */}
          {!loading && activeTab !== 'Catering Packages' && (
            activeCatItems.length === 0 ? (
              <div style={{ color: '#888', fontSize: 14, padding: '40px 0', textAlign: 'center' }}>No items in this category.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeCatItems.map((item, i) => (
                  <div key={i} style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', overflow: 'hidden', display: 'flex' }}>
                    {item.image && <img src={item.image} alt={item.name} style={{ width: 100, height: 100, objectFit: 'cover', flexShrink: 0 }} />}
                    <div style={{ flex: 1, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 3 }}>{item.name}</div>
                        {item.description && <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: 0 }}>{item.description}</p>}
                      </div>
                      {item.price != null && <div style={{ fontSize: 15, fontWeight: 700, color: DARK, flexShrink: 0 }}>${(item.price / 100).toFixed(2)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* Right: sticky order sidebar */}
        {restaurantRef && (
          <div className="order-sidebar" style={{ width: 340, flexShrink: 0 }}>
            <div style={{ position: 'sticky', top: 80, background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', overflow: 'hidden', boxShadow: '0 4px 24px rgba(0,0,0,0.06)', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto' }}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
                <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
              </div>
              {sidebarContent}
            </div>
          </div>
        )}
      </div>

      {/* Mobile sticky bar */}
      {restaurantRef && (
        <div className="mobile-order-bar"
          style={{ display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, padding: '12px 16px', background: '#fff', borderTop: '1px solid #f0f0f0', boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', zIndex: 100 }}>
          <button onClick={() => setMobileOrderOpen(true)}
            style={{ width: '100%', padding: '14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 14px rgba(91,111,232,0.25)' }}>
            {orderDone ? '🎉 Order Confirmed' : orderItem ? `${orderItem.headcount} guests · ${canPlaceOrder ? 'Review Order' : 'Configure Order'}` : 'Order Catering →'}
          </button>
        </div>
      )}

      {/* Mobile order overlay */}
      {mobileOrderOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid #f0f0f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: DARK }}>Order Summary</div>
              <div style={{ fontSize: 12, color: '#888' }}>{restaurant.name}</div>
            </div>
            <button onClick={() => setMobileOrderOpen(false)}
              style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
          </div>
          {sidebarContent}
        </div>
      )}

      {/* Add to Order modal */}
      {addModal && (
        <div onClick={() => setAddModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, padding: '24px', maxWidth: 420, width: '100%', maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            {addModal.image && (
              <img src={addModal.image} alt={addModal.name} style={{ width: '100%', height: 170, objectFit: 'cover', borderRadius: 12, marginBottom: 16 }} />
            )}
            <h2 style={{ fontSize: 19, fontWeight: 800, color: DARK, margin: '0 0 4px' }}>{addModal.name}</h2>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>
              ${(addModal.price / 100).toFixed(2)}/pp{addModal.serves ? ` · Serves up to ${addModal.serves}` : ''}
            </div>
            {addModal.description && <p style={{ fontSize: 13, color: '#777', lineHeight: 1.5, margin: '0 0 16px' }}>{addModal.description}</p>}

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 8 }}>Number of Guests</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={() => setAddHeadcount(h => Math.max(1, h - 1))}
                  style={{ width: 36, height: 36, borderRadius: 9, border: '1.5px solid #e8e8e8', background: '#fff', fontSize: 20, cursor: 'pointer', color: DARK, fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <input type="number" value={addHeadcount} min={1}
                  onChange={e => setAddHeadcount(Math.max(1, parseInt(e.target.value) || 1))}
                  style={{ width: 72, padding: '8px', border: '1.5px solid #e8e8e8', borderRadius: 9, fontSize: 15, fontFamily: F, color: DARK, textAlign: 'center', outline: 'none', boxSizing: 'border-box' }} />
                <button onClick={() => setAddHeadcount(h => h + 1)}
                  style={{ width: 36, height: 36, borderRadius: 9, border: '1.5px solid #e8e8e8', background: '#fff', fontSize: 20, cursor: 'pointer', color: DARK, fontFamily: F, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                <span style={{ fontSize: 13, color: '#888' }}>≈ ${(addModal.price * addHeadcount / 100).toFixed(2)}</span>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 8 }}>
                Special Instructions <span style={{ fontWeight: 400, color: '#bbb' }}>(optional)</span>
              </div>
              <textarea value={addInstructions} onChange={e => setAddInstructions(e.target.value)}
                placeholder="Allergies, dietary restrictions, special requests…" rows={3}
                style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e8e8e8', borderRadius: 9, fontSize: 13, fontFamily: F, color: DARK, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setAddModal(null)}
                style={{ flex: 1, padding: '12px', background: '#f0f0f0', color: DARK, border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Cancel
              </button>
              <button onClick={confirmAdd}
                style={{ flex: 2, padding: '12px', background: BLUE, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Login modal */}
      {loginOpen && (
        <div onClick={() => setLoginOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, padding: '28px', maxWidth: 380, width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: 0 }}>Log In to Order</h2>
              <button onClick={() => setLoginOpen(false)}
                style={{ background: '#f0f0f0', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
            </div>
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Email</label>
                <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required autoComplete="email"
                  style={{ width: '100%', padding: '12px 14px', border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 15, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                  placeholder="you@example.com" />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>Password</label>
                <input type="password" value={loginPw} onChange={e => setLoginPw(e.target.value)} required autoComplete="current-password"
                  style={{ width: '100%', padding: '12px 14px', border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 15, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
                  placeholder="••••••••" />
              </div>
              {loginError && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 14 }}>{loginError}</div>}
              <button type="submit" disabled={loginLoading}
                style={{ width: '100%', padding: '13px', background: BLUE, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: loginLoading ? 'not-allowed' : 'pointer', fontFamily: F, opacity: loginLoading ? 0.7 : 1, boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
                {loginLoading ? 'Logging in…' : 'Log In & Continue →'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {paymentOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 20, padding: '28px', maxWidth: 440, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.18)' }}>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 20px' }}>Review & Pay</h2>

            {/* Order summary */}
            <div style={{ background: '#f8f8fc', borderRadius: 12, padding: '16px', marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 10 }}>{orderItem?.pkg.name}</div>
              {[
                ['Date', selDate ? fmtDate(selDate) : '—'],
                ['Time', selTime ? fmtTime(selTime) : '—'],
                ['Guests', orderItem ? `${orderItem.headcount} people` : '—'],
                orderType === 'DELIVERY' ? ['Deliver to', `${addr.line1}${addr.city ? `, ${addr.city}` : ''}`] : ['Order type', 'Pickup'],
              ].map(([label, val]) => (
                <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                  <span>{label}</span><span style={{ fontWeight: 500, color: DARK }}>{val}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>
                {dispSubtotal > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 4 }}>
                    <span>Subtotal</span><span>${(dispSubtotal / 100).toFixed(2)}</span>
                  </div>
                )}
                {dispDelivery > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 4 }}>
                    <span>Delivery fee</span><span>${(dispDelivery / 100).toFixed(2)}</span>
                  </div>
                )}
                {dispTax > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 4 }}>
                    <span>Tax</span><span>${(dispTax / 100).toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, color: DARK, marginTop: 6 }}>
                  <span>Total</span>
                  <span>{dispTotal > 0 ? `$${(dispTotal / 100).toFixed(2)}` : 'Calculated at placement'}</span>
                </div>
              </div>
            </div>

            {/* Payment method */}
            {savedCard ? (
              <div style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #f0f0f0', padding: '14px 16px', marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>Saved payment method</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 24 }}>💳</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>
                      {savedCard.brand || savedCard.cardBrand || 'Card'} ···· {savedCard.last4 || savedCard.lastFour || '••••'}
                    </div>
                    {(savedCard.expMonth || savedCard.exp_month) && (
                      <div style={{ fontSize: 12, color: '#888' }}>Exp {savedCard.expMonth || savedCard.exp_month}/{String(savedCard.expYear || savedCard.exp_year).slice(-2)}</div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ background: '#fff', borderRadius: 12, border: '1.5px solid #f0f0f0', padding: '14px 16px', marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 10 }}>Card details</div>
                {stripeKey
                  ? <div ref={cardRef} style={{ padding: '4px 0', minHeight: 20 }} />
                  : <div style={{ fontSize: 13, color: '#bbb' }}>Loading secure payment form…</div>
                }
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f8f8fc', borderRadius: 9, padding: '10px 14px', marginBottom: 16 }}>
              <span style={{ fontSize: 14 }}>🔒</span>
              <span style={{ fontSize: 12, color: '#888' }}>Payments processed securely by Stripe.</span>
            </div>

            {paymentError && (
              <div style={{ background: '#FEF2F2', border: '1.5px solid #FCA5A5', borderRadius: 10, padding: '11px 14px', marginBottom: 14, color: '#991B1B', fontSize: 13 }}>
                {paymentError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setPaymentOpen(false); setPaymentError('') }}
                style={{ flex: 1, padding: '13px', background: '#f0f0f0', color: DARK, border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                Back
              </button>
              <button onClick={handleConfirmPayment} disabled={paymentLoading}
                style={{ flex: 2, padding: '13px', background: BLUE, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: paymentLoading ? 'not-allowed' : 'pointer', fontFamily: F, opacity: paymentLoading ? 0.7 : 1, boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
                {paymentLoading ? 'Processing…' : dispTotal > 0 ? `Pay $${(dispTotal / 100).toFixed(2)} →` : 'Place Order →'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        * { box-sizing: border-box; }
        input:focus, textarea:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.12) !important; }
        @media (max-width: 768px) {
          .order-sidebar { display: none !important; }
          .mobile-order-bar { display: block !important; }
        }
      `}</style>
    </div>
  )
}
