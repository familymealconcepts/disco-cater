'use client'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { buildCheckoutPayload } from '../../../../../../lib/pricing/checkout'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

// ── FM public mealPackages shapes (prices are DOLLARS, not cents — same as the
//    customer flow's RestaurantClient/CheckoutDrawer; never divide by 100) ─────
interface FmAddOn { reference: string; name: string; price: number; visible?: boolean }
interface FmExtraItemsGroup {
  reference: string; name: string
  minSelectedItems?: number; maxSelectedItems?: number
  visible?: boolean; enabled?: boolean
  addOns: FmAddOn[]
}
interface Pkg {
  reference: string; name: string; description?: string | null
  price: number; serves?: string | number | null
  available?: boolean; allowedSpecialInstructions?: boolean
  extraItemsGroups?: FmExtraItemsGroup[]
}

type PaymentMethod = 'PAYMENT' | 'INVOICE'

// Mirrors CheckoutDrawer.extractFmMoney — FM returns the priced totals under
// data.checkoutPublicResponseDto (tax = state+local+other). Dollars.
interface Money { subtotal: number | null; fee: number; tax: number; serviceCharge: number; deliveryFee: number | null; tips: number | null; discount: number; total: number | null }
function extractFmMoney(raw: any): Money | null {
  if (!raw) return null
  const d = raw?.data?.checkoutPublicResponseDto ?? raw?.data ?? raw
  if (!d || typeof d !== 'object') return null
  const num = (v: any) => (typeof v === 'number' ? v : 0)
  const components = num(d.stateSalesTaxInPrice) + num(d.localSalesTaxInPrice) + num(d.otherSalesTaxInPrice)
  const tax = components > 0 ? components : num(d.tax ?? d.taxAmount)
  return {
    subtotal: d.subtotal ?? d.subTotal ?? null,
    fee: num(d.fee ?? d.serviceFee ?? d.platformFee),
    tax,
    serviceCharge: num(d.serviceCharge),
    deliveryFee: d.deliveryFee ?? d.delivery ?? null,
    tips: d.tipsInPrice ?? d.tips ?? null,
    discount: num(d.discount),
    total: d.total ?? d.totalAmount ?? d.totalCost ?? null,
  }
}

const fmt$ = (n: number) => `$${n.toFixed(2)}`

export default function CreateOrderClient({ restaurantRef, packages }: { restaurantRef: string; packages: Pkg[] }) {
  const router = useRouter()

  // Step 1 — method choice (null = show the modal, mirrors FM's create-order popup)
  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [pendingMethod, setPendingMethod] = useState<PaymentMethod>('PAYMENT')

  // Customer (raw entry — no lookup in V1; FM matches/creates by email)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')

  // Items — qty + selected modifiers keyed by package reference
  const [qtyByPkg, setQtyByPkg] = useState<Record<string, number>>({})
  const [addOnsByPkg, setAddOnsByPkg] = useState<Record<string, Record<string, number>>>({})
  const [noteByPkg, setNoteByPkg] = useState<Record<string, string>>({})

  // Fulfillment
  const [orderType, setOrderType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [dates, setDates] = useState<string[]>([])
  const [times, setTimes] = useState<string[]>([])

  // Delivery address
  const [addr, setAddr] = useState({ line1: '', line2: '', city: '', state: '', zip: '', instructions: '' })
  const [addrCoords, setAddrCoords] = useState<{ lat?: number; lng?: number }>({})
  const [addrValidated, setAddrValidated] = useState(false)
  const [addrMsg, setAddrMsg] = useState('')

  // Adjustments
  const [tipAmt, setTipAmt] = useState(0)
  const [couponInput, setCouponInput] = useState('')
  const [couponApplied, setCouponApplied] = useState('')
  const [taxExempt, setTaxExempt] = useState(false)
  const [taxExemptId, setTaxExemptId] = useState('')
  const [taxExemptState, setTaxExemptState] = useState('')

  // Pricing + order state
  const [orderRef, setOrderRef] = useState('')
  const orderRefRef = useRef('')
  const [totals, setTotals] = useState<Money | null>(null)
  const [pricing, setPricing] = useState(false)
  const previewSeq = useRef(0)

  // Submission
  const [placing, setPlacing] = useState(false)
  const [error, setError] = useState('')

  // Stripe (payment path — fields are rendered so the page looks complete, but
  // submission is gated; see handlePlaceOrder)
  const [stripeKey, setStripeKey] = useState('')
  const numberRef = useRef<HTMLDivElement>(null)
  const expiryRef = useRef<HTMLDivElement>(null)
  const cvcRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const numberElRef = useRef<any>(null)
  const expiryElRef = useRef<any>(null)
  const cvcElRef = useRef<any>(null)

  const availablePackages = useMemo(() => packages.filter(p => p.available !== false), [packages])

  // Derived cart lines in the shape buildCheckoutPayload expects.
  const cart = useMemo(() => {
    return availablePackages
      .filter(p => (qtyByPkg[p.reference] || 0) > 0)
      .map(p => {
        const sel = addOnsByPkg[p.reference] || {}
        const addOns = (p.extraItemsGroups || []).flatMap(g =>
          g.addOns.filter(a => (sel[a.reference] || 0) > 0).map(a => ({
            reference: a.reference, name: a.name, price: a.price,
            count: sel[a.reference], extraItemsGroupReference: g.reference,
          }))
        )
        return {
          reference: p.reference, name: p.name, price: p.price,
          count: qtyByPkg[p.reference], addOns,
          note: noteByPkg[p.reference]?.trim() || undefined,
        }
      })
  }, [availablePackages, qtyByPkg, addOnsByPkg, noteByPkg])

  const firstPkgRef = cart[0]?.reference || null

  // Local subtotal estimate (FM re-prices server-side; this is just a hint until
  // the init/update call returns authoritative totals).
  const estSubtotal = useMemo(() => cart.reduce((s, l) => {
    const addons = l.addOns.reduce((a, m) => a + m.price * m.count, 0)
    return s + (l.price + addons) * l.count
  }, 0), [cart])

  const fmAddr = useMemo(() => ({
    addressLine1: addr.line1,
    ...(addr.line2 ? { addressLine2: addr.line2 } : {}),
    city: addr.city, state: addr.state, zipcode: addr.zip,
    ...(addrCoords.lat != null ? { latitude: addrCoords.lat } : {}),
    ...(addrCoords.lng != null ? { longitude: addrCoords.lng } : {}),
    ...(addr.instructions ? { deliveryInstructions: addr.instructions } : {}),
  }), [addr, addrCoords])

  // ── Build the priced DTO (mirrors CheckoutDrawer.buildCheckoutDto) ──────────
  const buildDto = useCallback(() => {
    const base = buildCheckoutPayload({
      restaurantRef,
      cart,
      orderType,
      orderDate: date,
      orderTime: time,
      deliveryAddress: orderType === 'DELIVERY' ? fmAddr : undefined,
    })
    return {
      ...base,
      tips: tipAmt,
      tipsType: tipAmt > 0 ? 'CUSTOM' : 'PERCENTAGE',
      taxExempt,
      ...(taxExempt ? { taxExemptId, taxExemptState } : {}),
      ...(couponApplied ? { couponCode: couponApplied } : {}),
    }
  }, [restaurantRef, cart, orderType, date, time, fmAddr, tipAmt, taxExempt, taxExemptId, taxExemptState, couponApplied])

  const canPrice = cart.length > 0 && !!date && !!time && (orderType === 'PICKUP' || addrValidated)

  // ── Pricing: init the first time (no PUT on first run — re-pricing a just-
  //    created order 500s in FM), then PUT /update to re-price afterwards. ─────
  const runPricing = useCallback(async () => {
    if (!canPrice) return
    const seq = ++previewSeq.current
    setPricing(true); setError('')
    try {
      const dto = buildDto()
      let ref = orderRefRef.current
      if (!ref) {
        const res = await fetch('/api/order/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dto) })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || data.message || 'Failed to create order draft.')
        ref = data.data?.orderReference || data.orderReference || data.reference || data.orderRef || data.id || ''
        if (!ref) throw new Error('Order created but no reference returned.')
        orderRefRef.current = ref
        setOrderRef(ref)
        if (seq === previewSeq.current) setTotals(extractFmMoney(data))
      } else {
        const res = await fetch('/api/order/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dto, restaurantRef, orderRef: ref }) })
        const data = await res.json()
        if (res.ok && !data.error && seq === previewSeq.current) setTotals(extractFmMoney(data))
      }
    } catch (e: any) {
      if (seq === previewSeq.current) setError(e.message || 'Could not price the order.')
    } finally {
      if (seq === previewSeq.current) setPricing(false)
    }
  }, [canPrice, buildDto, restaurantRef])

  // Auto re-price (debounced) whenever priceable inputs change.
  useEffect(() => {
    if (!canPrice) return
    const t = setTimeout(() => { runPricing().catch(() => {}) }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPrice, JSON.stringify(cart), date, time, orderType, addrValidated, tipAmt, taxExempt, couponApplied, JSON.stringify(fmAddr)])

  // ── Dates / times — keyed by the first cart package, exactly like the
  //    customer OrderWizard (Risk D: replicate that pattern). ─────────────────
  useEffect(() => {
    if (!firstPkgRef) { setDates([]); return }
    fetch(`/api/order/dates?packageRef=${firstPkgRef}`)
      .then(r => r.json())
      .then(d => {
        const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.dates) ? d.dates : Array.isArray(d?.availableDates) ? d.availableDates : []
        setDates(arr.map(x => (typeof x === 'string' ? x : x.date || x.localDate || String(x))))
      })
      .catch(() => setDates([]))
  }, [firstPkgRef])

  useEffect(() => {
    if (!firstPkgRef || !date) { setTimes([]); return }
    fetch(`/api/order/times?packageRef=${firstPkgRef}&date=${date}`)
      .then(r => r.json())
      .then(d => {
        const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.times) ? d.times : Array.isArray(d?.availableTimes) ? d.availableTimes : Array.isArray(d?.pickUpTimes) ? d.pickUpTimes : []
        setTimes(arr.map(x => (typeof x === 'string' ? x : x.time || x.localTime || String(x))))
      })
      .catch(() => setTimes([]))
  }, [firstPkgRef, date])

  // ── Stripe key + Elements mount (payment path only; submission gated) ───────
  useEffect(() => {
    if (method !== 'PAYMENT') return
    const envKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (envKey) { setStripeKey(envKey); return }
    fetch('/api/order/stripe-info')
      .then(r => r.json())
      .then(d => setStripeKey(d.publishableKey || d.publicKey || d.stripePublishableKey || d.key || ''))
      .catch(() => {})
  }, [method])

  useEffect(() => {
    if (method !== 'PAYMENT' || !stripeKey) return
    const w = window as any
    const mount = () => {
      if (!w.Stripe || numberElRef.current) return
      if (!numberRef.current || !expiryRef.current || !cvcRef.current) return
      stripeRef.current = w.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      const style = { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#bbb' } } }
      // disableLink + showIcon:false → no Stripe Link badge, matching the
      // customer checkout. (See [[checkout-saved-card]] pattern.)
      numberElRef.current = elements.create('cardNumber', { style, showIcon: false, disableLink: true })
      expiryElRef.current = elements.create('cardExpiry', { style })
      cvcElRef.current = elements.create('cardCvc', { style })
      numberElRef.current.mount(numberRef.current)
      expiryElRef.current.mount(expiryRef.current)
      cvcElRef.current.mount(cvcRef.current)
    }
    if (w.Stripe) mount()
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    }
    return () => {
      for (const r of [numberElRef, expiryElRef, cvcElRef]) {
        if (r.current) { r.current.destroy(); r.current = null }
      }
    }
  }, [method, stripeKey])

  // ── Delivery address validation (+ geocode for lat/lng) ─────────────────────
  async function validateAddress() {
    setAddrMsg(''); setAddrValidated(false)
    if (!addr.line1 || !addr.city || !addr.state || !addr.zip) { setAddrMsg('Fill in street, city, state and ZIP first.'); return }
    let coords: { lat?: number; lng?: number } = {}
    const gkey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    if (gkey) {
      try {
        const q = encodeURIComponent(`${addr.line1}, ${addr.city}, ${addr.state} ${addr.zip}`)
        const g = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${q}&key=${gkey}`).then(r => r.json())
        const loc = g?.results?.[0]?.geometry?.location
        if (loc) coords = { lat: loc.lat, lng: loc.lng }
      } catch {}
    }
    setAddrCoords(coords)
    try {
      const body = {
        restaurantReference: restaurantRef,
        deliveryAddress: {
          addressLine1: addr.line1, ...(addr.line2 ? { addressLine2: addr.line2 } : {}),
          city: addr.city, state: addr.state, zipcode: addr.zip,
          ...(coords.lat != null ? { latitude: coords.lat } : {}),
          ...(coords.lng != null ? { longitude: coords.lng } : {}),
        },
      }
      const res = await fetch('/api/order/validate-address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) { setAddrValidated(true); setAddrMsg('Address validated.') }
      else { setAddrValidated(true); setAddrMsg('Saved (delivery range not confirmed).') }
    } catch {
      setAddrValidated(true); setAddrMsg('Saved (validation unavailable).')
    }
  }

  // ── Place ───────────────────────────────────────────────────────────────────
  const customerValid = !!(firstName.trim() && lastName.trim() && /\S+@\S+\.\S+/.test(email) && phone.trim())
  const fulfillmentValid = cart.length > 0 && !!date && !!time && (orderType === 'PICKUP' || addrValidated)
  const canSubmit = customerValid && fulfillmentValid && !placing

  async function placeOrder(paymentMethod: PaymentMethod) {
    if (!canSubmit) return
    setPlacing(true); setError('')
    try {
      // Make sure the order is priced/drafted (orderRef exists) before placing.
      if (!orderRefRef.current) { await runPricing() }
      if (!orderRefRef.current) throw new Error('Could not create the order draft. Check the items, date and time.')

      const checkoutDetails: Record<string, unknown> = {
        ...buildDto(),
        paymentMethod,
        // Direct entry = restaurant placing for their own customer → 1P, no lead
        // gen fee. See [[sourceoforder-disco]].
        sourceoforder: 'FAMILYMEAL',
      }
      delete checkoutDetails.restaurantRef // proxy-URL field only

      const res = await fetch('/api/restaurant/orders/place', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantRef,
          orderRef: orderRefRef.current,
          checkoutDetails,
          customer: { firstName, lastName, email, phoneNumber: phone },
          ...(orderType === 'DELIVERY' ? { deliveryAddress: fmAddr } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok && data.error) throw new Error(data.error || data.message || 'Failed to place order.')

      // Invoice path: order is created unpaid; FM emails the payment link. No
      // confirm-payment call. Done.
      router.push('/restaurant/orders')
    } catch (e: any) {
      setError(e.message || 'Something went wrong placing the order.')
      setPlacing(false)
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #eee', borderRadius: 12, padding: 20, marginBottom: 18 }
  const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: DARK, margin: '0 0 14px' }
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 5 }
  const input: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
  const chip = (sel: boolean): React.CSSProperties => ({ padding: '8px 14px', borderRadius: 10, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`, background: sel ? '#EEF0FD' : '#fff', color: sel ? BLUE : DARK, fontFamily: F, fontSize: 13, fontWeight: sel ? 700 : 500, cursor: 'pointer' })
  const stepBtn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1.5px solid #e0e0e0', background: '#fff', fontSize: 17, cursor: 'pointer', color: DARK, fontFamily: F, lineHeight: 1 }

  // ── Step 1: method modal ────────────────────────────────────────────────────
  if (!method) {
    return (
      <div style={{ padding: '28px 32px', fontFamily: F }}>
        <FontImport />
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Create Order</h1>
        <p style={{ fontSize: 13, color: '#888', margin: '0 0 24px' }}>How will this order be paid?</p>
        <div style={{ ...card, maxWidth: 460 }}>
          {([['PAYMENT', 'Payment Method', 'Enter the customer’s details and pay by card now.'], ['INVOICE', 'Invoice Method', 'Create an unpaid order and email the customer a payment link. No card required.']] as const).map(([val, title, desc]) => (
            <label key={val} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', cursor: 'pointer', borderBottom: val === 'PAYMENT' ? '1px solid #f3f3f3' : 'none' }}>
              <input type="radio" name="create-method" checked={pendingMethod === val} onChange={() => setPendingMethod(val)} style={{ accentColor: BLUE, width: 16, height: 16, marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{title}</div>
                <div style={{ fontSize: 12.5, color: '#888', marginTop: 2 }}>{desc}</div>
              </div>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => router.push('/restaurant/orders')} style={{ padding: '10px 18px', background: '#f0f0f0', color: DARK, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>Cancel</button>
          <button onClick={() => setMethod(pendingMethod)} style={{ padding: '10px 22px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>Continue →</button>
        </div>
      </div>
    )
  }

  // ── Step 2: order builder ───────────────────────────────────────────────────
  const liveSubtotal = totals?.subtotal ?? estSubtotal
  const grandTotal = totals?.total ?? null

  return (
    <div style={{ padding: '28px 32px', fontFamily: F, maxWidth: 820 }}>
      <FontImport />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: DARK, margin: 0 }}>Create Order</h1>
        <button onClick={() => setMethod(null)} style={{ fontSize: 12.5, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F, fontWeight: 600 }}>
          {method === 'INVOICE' ? 'Invoice Method' : 'Payment Method'} · change
        </button>
      </div>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 22px' }}>Placed directly for your customer (1P).</p>

      {/* Customer */}
      <div style={card}>
        <h2 style={h2}>Customer</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={label}>First name</label><input style={input} value={firstName} onChange={e => setFirstName(e.target.value)} /></div>
          <div><label style={label}>Last name</label><input style={input} value={lastName} onChange={e => setLastName(e.target.value)} /></div>
          <div><label style={label}>Email</label><input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="customer@example.com" /></div>
          <div><label style={label}>Phone</label><input style={input} value={phone} onChange={e => setPhone(e.target.value)} placeholder="555-555-5555" /></div>
        </div>
      </div>

      {/* Items */}
      <div style={card}>
        <h2 style={h2}>Items</h2>
        {availablePackages.length === 0 && <div style={{ fontSize: 13, color: '#aaa' }}>No packages available for this location.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {availablePackages.map(p => {
            const qty = qtyByPkg[p.reference] || 0
            const sel = addOnsByPkg[p.reference] || {}
            return (
              <div key={p.reference} style={{ border: '1px solid #f0f0f0', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{fmt$(p.price)}{p.serves ? ` · serves ${p.serves}` : ''}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button style={stepBtn} onClick={() => setQtyByPkg(s => ({ ...s, [p.reference]: Math.max(0, (s[p.reference] || 0) - 1) }))}>−</button>
                    <span style={{ minWidth: 22, textAlign: 'center', fontSize: 14, fontWeight: 700, color: DARK }}>{qty}</span>
                    <button style={stepBtn} onClick={() => setQtyByPkg(s => ({ ...s, [p.reference]: (s[p.reference] || 0) + 1 }))}>+</button>
                  </div>
                </div>

                {qty > 0 && (p.extraItemsGroups || []).some(g => g.visible !== false && g.addOns?.length) && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f5f5f5' }}>
                    {(p.extraItemsGroups || []).filter(g => g.visible !== false && g.addOns?.length).map(g => (
                      <div key={g.reference} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#999', textTransform: 'uppercase', marginBottom: 6 }}>{g.name}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {g.addOns.filter(a => a.visible !== false).map(a => {
                            const c = sel[a.reference] || 0
                            return (
                              <div key={a.reference} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                                <span style={{ fontSize: 13, color: '#555' }}>{a.name}{a.price > 0 ? ` (+${fmt$(a.price)})` : ''}</span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <button style={stepBtn} onClick={() => setAddOnsByPkg(s => ({ ...s, [p.reference]: { ...(s[p.reference] || {}), [a.reference]: Math.max(0, c - 1) } }))}>−</button>
                                  <span style={{ minWidth: 18, textAlign: 'center', fontSize: 13, fontWeight: 600 }}>{c}</span>
                                  <button style={stepBtn} onClick={() => setAddOnsByPkg(s => ({ ...s, [p.reference]: { ...(s[p.reference] || {}), [a.reference]: c + 1 } }))}>+</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {qty > 0 && p.allowedSpecialInstructions && (
                  <input style={{ ...input, marginTop: 8 }} placeholder="Special instructions (optional)" value={noteByPkg[p.reference] || ''} onChange={e => setNoteByPkg(s => ({ ...s, [p.reference]: e.target.value }))} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Fulfillment */}
      <div style={card}>
        <h2 style={h2}>Fulfillment</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['PICKUP', 'DELIVERY'] as const).map(t => (
            <button key={t} style={chip(orderType === t)} onClick={() => { setOrderType(t); resetDraft() }}>{t === 'PICKUP' ? 'Pickup' : 'Delivery'}</button>
          ))}
        </div>

        <label style={label}>Date</label>
        {dates.length === 0
          ? <div style={{ fontSize: 13, color: '#aaa', marginBottom: 14 }}>{firstPkgRef ? 'No available dates for the selected items.' : 'Add an item to load available dates.'}</div>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {dates.map(d => <button key={d} style={chip(date === d)} onClick={() => { setDate(d); setTime('') }}>{fmtDate(d)}</button>)}
            </div>}

        {date && (
          <>
            <label style={label}>Time</label>
            {times.length === 0
              ? <div style={{ fontSize: 13, color: '#aaa' }}>No available times for {fmtDate(date)}.</div>
              : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {times.map(t => <button key={t} style={chip(time === t)} onClick={() => setTime(t)}>{fmtTime(t)}</button>)}
                </div>}
          </>
        )}

        {orderType === 'DELIVERY' && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f3f3f3' }}>
            <label style={label}>Delivery address</label>
            <input style={{ ...input, marginBottom: 8 }} placeholder="Street address" value={addr.line1} onChange={e => { setAddr(a => ({ ...a, line1: e.target.value })); setAddrValidated(false) }} />
            <input style={{ ...input, marginBottom: 8 }} placeholder="Apt / suite (optional)" value={addr.line2} onChange={e => setAddr(a => ({ ...a, line2: e.target.value }))} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 110px', gap: 8, marginBottom: 8 }}>
              <input style={input} placeholder="City" value={addr.city} onChange={e => { setAddr(a => ({ ...a, city: e.target.value })); setAddrValidated(false) }} />
              <input style={input} placeholder="ST" maxLength={2} value={addr.state} onChange={e => { setAddr(a => ({ ...a, state: e.target.value.toUpperCase() })); setAddrValidated(false) }} />
              <input style={input} placeholder="ZIP" value={addr.zip} onChange={e => { setAddr(a => ({ ...a, zip: e.target.value })); setAddrValidated(false) }} />
            </div>
            <input style={{ ...input, marginBottom: 10 }} placeholder="Delivery instructions (optional)" value={addr.instructions} onChange={e => setAddr(a => ({ ...a, instructions: e.target.value }))} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button onClick={validateAddress} style={{ padding: '8px 16px', background: addrValidated ? '#E8F5E9' : '#f0f0f0', color: addrValidated ? '#2E7D32' : DARK, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F }}>
                {addrValidated ? '✓ Validated' : 'Validate address'}
              </button>
              {addrMsg && <span style={{ fontSize: 12, color: '#888' }}>{addrMsg}</span>}
            </div>
          </div>
        )}
      </div>

      {/* Adjustments */}
      <div style={card}>
        <h2 style={h2}>Tip, Promo & Tax</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={label}>Tip ($)</label>
            <input style={input} type="number" min={0} step="0.01" value={tipAmt || ''} onChange={e => setTipAmt(Math.max(0, parseFloat(e.target.value) || 0))} placeholder="0.00" />
          </div>
          <div>
            <label style={label}>Promo code</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={input} value={couponInput} onChange={e => setCouponInput(e.target.value)} placeholder="Code" />
              <button onClick={() => setCouponApplied(couponInput.trim())} style={{ padding: '0 14px', background: '#f0f0f0', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, color: DARK }}>Apply</button>
            </div>
            {couponApplied && <div style={{ fontSize: 12, color: '#2E7D32', marginTop: 4 }}>Applied: {couponApplied}</div>}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, cursor: 'pointer', fontSize: 13, color: DARK }}>
          <input type="checkbox" checked={taxExempt} onChange={e => setTaxExempt(e.target.checked)} style={{ accentColor: BLUE }} />
          Tax exempt
        </label>
        {taxExempt && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8, marginTop: 10 }}>
            <input style={input} placeholder="Tax exempt ID" value={taxExemptId} onChange={e => setTaxExemptId(e.target.value)} />
            <input style={input} placeholder="State" maxLength={2} value={taxExemptState} onChange={e => setTaxExemptState(e.target.value.toUpperCase())} />
          </div>
        )}
      </div>

      {/* Payment (gated) */}
      {method === 'PAYMENT' && (
        <div style={card}>
          <h2 style={h2}>Payment</h2>
          <div style={{ opacity: 0.85 }}>
            <label style={label}>Card number</label>
            <div ref={numberRef} style={{ ...input, padding: '11px 12px' }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1 }}><label style={label}>Expiry</label><div ref={expiryRef} style={{ ...input, padding: '11px 12px' }} /></div>
              <div style={{ flex: 1 }}><label style={label}>CVC</label><div ref={cvcRef} style={{ ...input, padding: '11px 12px' }} /></div>
            </div>
            {!stripeKey && <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>Loading secure payment form…</div>}
          </div>
          <div style={{ marginTop: 14, background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, color: '#8D6E00' }}>
            Card payment for direct entry is coming soon. For now, use <strong>Invoice Method</strong> to send the customer a payment link.
          </div>
        </div>
      )}

      {/* Summary + place */}
      <div style={{ ...card, position: 'sticky', bottom: 0 }}>
        <h2 style={h2}>Summary</h2>
        <Row k="Subtotal" v={liveSubtotal != null ? fmt$(liveSubtotal) : '—'} />
        {totals?.deliveryFee ? <Row k="Delivery" v={fmt$(totals.deliveryFee)} /> : null}
        {totals?.serviceCharge ? <Row k="Service" v={fmt$(totals.serviceCharge)} /> : null}
        {totals && totals.tax > 0 ? <Row k="Tax & fees" v={fmt$(totals.tax + totals.fee)} /> : null}
        {totals?.tips ? <Row k="Tip" v={fmt$(totals.tips)} /> : (tipAmt > 0 ? <Row k="Tip" v={fmt$(tipAmt)} /> : null)}
        {totals && totals.discount > 0 ? <Row k="Discount" v={`−${fmt$(totals.discount)}`} /> : null}
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, marginTop: 6, borderTop: '1px solid #eee', fontSize: 16, fontWeight: 800, color: DARK }}>
          <span>Total</span><span>{pricing ? 'Calculating…' : grandTotal != null ? fmt$(grandTotal) : '—'}</span>
        </div>

        {error && <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, padding: '10px 12px', margin: '14px 0 0', color: '#991B1B', fontSize: 13 }}>{error}</div>}

        <div style={{ marginTop: 16 }}>
          {method === 'INVOICE' ? (
            <button onClick={() => placeOrder('INVOICE')} disabled={!canSubmit}
              style={{ width: '100%', padding: '13px', background: DARK, color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: canSubmit ? 'pointer' : 'not-allowed', fontFamily: F, opacity: canSubmit ? 1 : 0.5 }}>
              {placing ? 'Sending…' : 'Send Invoice'}
            </button>
          ) : (
            // Payment path — pending confirmation that FM accepts restaurant JWT
            // on confirmPayment endpoint. UI is complete; submission is gated.
            <button disabled
              style={{ width: '100%', padding: '13px', background: '#ccc', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'not-allowed', fontFamily: F }}>
              Pay & Place Order (coming soon)
            </button>
          )}
          {!customerValid && <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>Enter customer name, email and phone to continue.</div>}
          {customerValid && !fulfillmentValid && <div style={{ fontSize: 12, color: '#aaa', marginTop: 8 }}>Add at least one item, a date and time{orderType === 'DELIVERY' ? ', and validate the delivery address' : ''}.</div>}
        </div>
      </div>
    </div>
  )

  // Reset the draft when fulfillment type flips (delivery/pickup changes pricing
  // basis; force a fresh init rather than PUT-ing across order types).
  function resetDraft() {
    orderRefRef.current = ''
    setOrderRef('')
    setTotals(null)
    setDate(''); setTime('')
    setAddrValidated(false)
  }
}

function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: '#555', marginBottom: 6 }}><span>{k}</span><span>{v}</span></div>
}

function FontImport() {
  return <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); input:focus{border-color:${BLUE} !important}`}</style>
}

function fmtDate(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) } catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
}
