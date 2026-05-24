'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import GlobalHeader from '../../../components/GlobalHeader'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const BLUE = '#5B6FE8'
const DARK = '#1A1028'

const FLOW: Step[] = ['package', 'date', 'time', 'details', 'review', 'payment']
const STEP_LABEL: Record<string, string> = { package: 'Package', date: 'Date', time: 'Time', details: 'Details', review: 'Review', payment: 'Pay' }
type Step = 'package' | 'date' | 'time' | 'details' | 'review' | 'payment' | 'done'

interface Pkg {
  reference: string
  name: string
  description?: string
  price: number
  serves?: number
  image?: string
}
interface Addr { line1: string; city: string; state: string; zipCode: string }

declare global { interface Window { Stripe?: (key: string) => any } }

export default function OrderWizard({
  restaurant, restaurantRef, packages, initialPackageRef, slug,
}: {
  restaurant: any
  restaurantRef: string
  packages: Pkg[]
  initialPackageRef: string | null
  slug: string
}) {
  const initPkg = initialPackageRef ? packages.find(p => p.reference === initialPackageRef) ?? null : null

  // Auth
  const [user, setUser] = useState<any>(null)

  // Order selections
  const [step, setStep] = useState<Step>(initPkg ? 'date' : 'package')
  const [pkg, setPkg] = useState<Pkg | null>(initPkg)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [headcount, setHeadcount] = useState(10)
  const [addr, setAddr] = useState<Addr>({ line1: '', city: '', state: '', zipCode: '' })

  // API responses
  const [dates, setDates] = useState<string[]>([])
  const [times, setTimes] = useState<string[]>([])
  const [orderRef, setOrderRef] = useState('')
  const [totals, setTotals] = useState<any>(null)
  const [savedCard, setSavedCard] = useState<any>(null)
  const [stripeKey, setStripeKey] = useState('')
  const [confirmation, setConfirmation] = useState<any>(null)

  // UI state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPw, setLoginPw] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Stripe refs
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  useEffect(() => {
    try {
      const s = localStorage.getItem('disco_user')
      if (s) setUser(JSON.parse(s))
    } catch {}
  }, [])

  // Fetch dates when entering date step
  useEffect(() => {
    if (step !== 'date' || !pkg) return
    setLoading(true); setError('')
    fetch(`/api/order/dates?packageRef=${pkg.reference}`)
      .then(r => r.json())
      .then(d => {
        const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.dates) ? d.dates : Array.isArray(d?.availableDates) ? d.availableDates : []
        setDates(arr.map(x => (typeof x === 'string' ? x : x.date || x.localDate || String(x))))
        setLoading(false)
      })
      .catch(() => { setError('Failed to load available dates.'); setLoading(false) })
  }, [step, pkg])

  // Fetch times when entering time step
  useEffect(() => {
    if (step !== 'time' || !pkg || !date) return
    setLoading(true); setError('')
    fetch(`/api/order/times?packageRef=${pkg.reference}&date=${date}`)
      .then(r => r.json())
      .then(d => {
        const arr: any[] = Array.isArray(d) ? d : Array.isArray(d?.times) ? d.times : Array.isArray(d?.availableTimes) ? d.availableTimes : Array.isArray(d?.pickUpTimes) ? d.pickUpTimes : []
        setTimes(arr.map(x => (typeof x === 'string' ? x : x.time || x.localTime || String(x))))
        setLoading(false)
      })
      .catch(() => { setError('Failed to load available times.'); setLoading(false) })
  }, [step, pkg, date])

  // Fetch Stripe info + saved card when entering payment step
  useEffect(() => {
    if (step !== 'payment' || !user) return
    fetch('/api/order/stripe-info', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(r => r.json())
      .then(d => setStripeKey(d.publishableKey || d.publicKey || d.stripePublishableKey || d.key || ''))
      .catch(() => {})
    fetch('/api/order/saved-card', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(r => r.json())
      .then(d => { if (d && !d.error && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setSavedCard(d) })
      .catch(() => {})
  }, [step, user])

  // Mount Stripe card element
  useEffect(() => {
    if (step !== 'payment' || !stripeKey || savedCard || !cardRef.current) return
    const mount = () => {
      if (!window.Stripe || !cardRef.current || cardElRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      cardElRef.current = elements.create('card', {
        style: { base: { fontFamily: F, fontSize: '16px', color: DARK, '::placeholder': { color: '#bbb' } } },
      })
      cardElRef.current.mount(cardRef.current)
    }
    if (window.Stripe) { mount() }
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    }
    return () => { if (cardElRef.current) { cardElRef.current.destroy(); cardElRef.current = null } }
  }, [step, stripeKey, savedCard])

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function proceedToReview() {
    if (!pkg || !date || !time) return
    if (!addr.line1 || !addr.city || !addr.state || !addr.zipCode) { setError('Please fill in all address fields.'); return }
    setLoading(true); setError('')
    try {
      // Validate address (non-blocking)
      await fetch('/api/order/validate-address', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deliveryAddress: addr }),
      }).catch(() => {})

      // Init order
      const initRes = await fetch('/api/order/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantRef, mealPackageReference: pkg.reference, localDate: date, localTime: time, persons: headcount, orderType: 'CATERING' }),
      })
      const initData = await initRes.json()
      if (!initRes.ok || initData.error) {
        setError(initData.error || initData.message || 'Failed to create order draft. Please try again.')
        setLoading(false); return
      }
      const ref = initData.reference || initData.orderReference || initData.orderRef || initData.id || initData.ref || ''
      if (!ref) { setError('Order created but no reference returned.'); setLoading(false); return }
      setOrderRef(ref)

      // Update order with address to get totals
      const updRes = await fetch('/api/order/update', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantRef, orderRef: ref, deliveryAddress: addr, persons: headcount }),
      })
      const updData = await updRes.json()
      if (updRes.ok && !updData.error) setTotals(updData)

      setLoading(false); setStep('review')
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  async function handlePlaceOrder() {
    if (!user) return
    setLoading(true); setError('')
    try {
      let token: string | null = null
      if (!savedCard) {
        if (!stripeRef.current || !cardElRef.current) {
          setError('Payment form not ready. Please wait a moment and try again.')
          setLoading(false); return
        }
        const result = await stripeRef.current.createToken(cardElRef.current)
        if (result.error) { setError(result.error.message || 'Card error.'); setLoading(false); return }
        token = result.token?.id ?? null
      }

      // Confirm payment
      const confRes = await fetch('/api/order/confirm-payment', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ orderReference: orderRef, token, useDefaultPayment: !!savedCard, restaurantReference: restaurantRef }),
      })
      const confData = await confRes.json()
      if (!confRes.ok && confData.error) {
        setError(confData.error || confData.message || 'Payment failed.')
        setLoading(false); return
      }

      // Place order
      const placeRes = await fetch('/api/order/place', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ restaurantRef, orderRef }),
      })
      const placeData = await placeRes.json()
      if (!placeRes.ok && placeData.error) {
        setError(placeData.error || placeData.message || 'Failed to place order.')
        setLoading(false); return
      }
      setConfirmation(placeData)
      setLoading(false); setStep('done')
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginLoading(true); setLoginError('')
    try {
      const res = await fetch('/api/fm-auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPw }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { setLoginError(data.error || 'Invalid email or password.'); setLoginLoading(false); return }
      localStorage.setItem('disco_user', JSON.stringify(data))
      setUser(data); setLoginLoading(false)
    } catch { setLoginError('Unable to connect. Please try again.'); setLoginLoading(false) }
  }

  // ── Computed totals ────────────────────────────────────────────────────────
  const estPricePerPerson = pkg ? pkg.price / 100 : 0
  const subtotalCents = totals?.subTotal ?? totals?.subtotal ?? totals?.totalCost ?? (pkg ? pkg.price * headcount : 0)
  const deliveryFeeCents = totals?.deliveryFee ?? totals?.delivery ?? 0
  const taxCents = totals?.tax ?? totals?.taxAmount ?? 0
  const totalCents = totals?.total ?? totals?.totalAmount ?? (subtotalCents + deliveryFeeCents + taxCents)
  const totalDisplay = `$${(totalCents / 100).toFixed(2)}`

  function fmtDate(d: string) {
    try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) } catch { return d }
  }
  function fmtTime(t: string) {
    try { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m); return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  const inputSt: React.CSSProperties = { width: '100%', padding: '12px 14px', border: '1.5px solid #e8e8e8', borderRadius: 10, fontSize: 15, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
  const labelSt: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }
  const backBtn: React.CSSProperties = { padding: '12px 22px', background: '#f0f0f0', color: DARK, border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: F }
  const nextBtn: React.CSSProperties = { padding: '13px 28px', background: BLUE, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }

  // ── Step renders ────────────────────────────────────────────────────────────

  function PackageStep() {
    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Choose a Package</h2>
        <p style={{ fontSize: 14, color: '#666', margin: '0 0 28px' }}>Select a catering package from {restaurant.name}</p>
        {packages.length === 0
          ? <div style={{ textAlign: 'center', padding: '48px 0', color: '#888', fontSize: 15 }}>No packages available for online ordering.</div>
          : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {packages.map(p => (
                <button key={p.reference} onClick={() => { setPkg(p); setStep('date') }}
                  style={{ background: '#fff', border: `2px solid ${pkg?.reference === p.reference ? BLUE : '#f0f0f0'}`, borderRadius: 16, overflow: 'hidden', cursor: 'pointer', textAlign: 'left', padding: 0, transition: 'all 0.15s' }}>
                  {p.image && <img src={p.image} alt={p.name} style={{ width: '100%', height: 130, objectFit: 'cover' }} />}
                  <div style={{ padding: 18 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 4 }}>{p.name}</div>
                    {p.serves && <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Serves {p.serves}</div>}
                    {p.description && <p style={{ fontSize: 13, color: '#666', lineHeight: 1.5, margin: '0 0 10px' }}>{p.description}</p>}
                    <div style={{ fontSize: 17, fontWeight: 800, color: DARK }}>${(p.price / 100).toFixed(2)}<span style={{ fontSize: 11, fontWeight: 400, color: '#888' }}>/pp</span></div>
                  </div>
                </button>
              ))}
            </div>
        }
      </>
    )
  }

  function DateStep() {
    if (loading) return <div style={{ color: '#888', fontSize: 14, padding: '32px 0' }}>Loading available dates…</div>
    if (!loading && dates.length === 0) return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <div style={{ fontSize: 15, color: '#888', marginBottom: 16 }}>No dates available right now for this package.</div>
        <button onClick={() => setStep('package')} style={backBtn}>← Back to Packages</button>
      </div>
    )
    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Pick a Date</h2>
        <p style={{ fontSize: 14, color: '#666', margin: '0 0 24px' }}>When would you like your catering?</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {dates.map(d => {
            const sel = d === date
            const dObj = new Date(d + 'T12:00:00')
            return (
              <button key={d} onClick={() => { setDate(d); setTime('') }}
                style={{ padding: '12px 18px', borderRadius: 12, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`, background: sel ? '#EEF0FD' : '#fff', color: sel ? BLUE : DARK, fontFamily: F, cursor: 'pointer', transition: 'all 0.1s', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: sel ? '#6B6EF9' : '#999', marginBottom: 2 }}>{dObj.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{dObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </button>
            )
          })}
        </div>
      </>
    )
  }

  function TimeStep() {
    if (loading) return <div style={{ color: '#888', fontSize: 14, padding: '32px 0' }}>Loading available times…</div>
    if (!loading && times.length === 0) return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <div style={{ fontSize: 15, color: '#888', marginBottom: 16 }}>No time slots available for {fmtDate(date)}.</div>
        <button onClick={() => setStep('date')} style={backBtn}>← Pick a different date</button>
      </div>
    )
    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Pick a Time</h2>
        <p style={{ fontSize: 14, color: '#666', margin: '0 0 24px' }}>{fmtDate(date)}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {times.map(t => {
            const sel = t === time
            return (
              <button key={t} onClick={() => setTime(t)}
                style={{ padding: '12px 22px', borderRadius: 12, border: `2px solid ${sel ? BLUE : '#e8e8e8'}`, background: sel ? '#EEF0FD' : '#fff', color: sel ? BLUE : DARK, fontFamily: F, fontSize: 15, fontWeight: sel ? 700 : 500, cursor: 'pointer', transition: 'all 0.1s' }}>
                {fmtTime(t)}
              </button>
            )
          })}
        </div>
      </>
    )
  }

  function DetailsStep() {
    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Order Details</h2>
        <p style={{ fontSize: 14, color: '#666', margin: '0 0 28px' }}>How many guests and where should we deliver?</p>

        <div style={{ marginBottom: 28 }}>
          <label style={labelSt}>Number of Guests</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setHeadcount(h => Math.max(1, h - 1))}
              style={{ width: 40, height: 40, borderRadius: 10, border: '1.5px solid #e8e8e8', background: '#fff', fontSize: 22, cursor: 'pointer', color: DARK, fontFamily: F, lineHeight: 1 }}>−</button>
            <input type="number" value={headcount} min={1}
              onChange={e => setHeadcount(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ ...inputSt, width: 80, textAlign: 'center' }} />
            <button onClick={() => setHeadcount(h => h + 1)}
              style={{ width: 40, height: 40, borderRadius: 10, border: '1.5px solid #e8e8e8', background: '#fff', fontSize: 22, cursor: 'pointer', color: DARK, fontFamily: F, lineHeight: 1 }}>+</button>
            {estPricePerPerson > 0 && (
              <span style={{ fontSize: 13, color: '#888', marginLeft: 4 }}>≈ ${(estPricePerPerson * headcount).toFixed(2)}</span>
            )}
          </div>
        </div>

        <div>
          <label style={labelSt}>Delivery Address</label>
          <input value={addr.line1} onChange={e => setAddr(a => ({ ...a, line1: e.target.value }))}
            placeholder="Street address" style={{ ...inputSt, marginBottom: 10 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px 100px', gap: 10 }}>
            <input value={addr.city} onChange={e => setAddr(a => ({ ...a, city: e.target.value }))} placeholder="City" style={inputSt} />
            <input value={addr.state} onChange={e => setAddr(a => ({ ...a, state: e.target.value.toUpperCase() }))} placeholder="ST" style={inputSt} maxLength={2} />
            <input value={addr.zipCode} onChange={e => setAddr(a => ({ ...a, zipCode: e.target.value }))} placeholder="ZIP" style={inputSt} />
          </div>
        </div>
      </>
    )
  }

  function ReviewStep() {
    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 24px' }}>Review Your Order</h2>
        <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid #f8f8f8' }}>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 3 }}>Package</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: DARK }}>{pkg?.name}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
            {[
              ['Date', fmtDate(date)],
              ['Time', fmtTime(time)],
              ['Guests', `${headcount} people`],
              ['Deliver to', `${addr.line1}, ${addr.city}, ${addr.state} ${addr.zipCode}`],
            ].map(([label, val], i) => (
              <div key={label} style={{ padding: '14px 22px', borderBottom: i < 2 ? '1px solid #f8f8f8' : 'none', borderRight: i % 2 === 0 ? '1px solid #f8f8f8' : 'none' }}>
                <div style={{ fontSize: 12, color: '#999', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: DARK }}>{val}</div>
              </div>
            ))}
          </div>
          <div style={{ padding: '18px 22px', borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
            {subtotalCents > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14, color: '#666' }}>
                <span>Subtotal</span><span>${(subtotalCents / 100).toFixed(2)}</span>
              </div>
            )}
            {deliveryFeeCents > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14, color: '#666' }}>
                <span>Delivery fee</span><span>${(deliveryFeeCents / 100).toFixed(2)}</span>
              </div>
            )}
            {taxCents > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14, color: '#666' }}>
                <span>Tax</span><span>${(taxCents / 100).toFixed(2)}</span>
              </div>
            )}
            {totalCents > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid #eee', fontSize: 18, fontWeight: 800, color: DARK }}>
                <span>Total</span><span>{totalDisplay}</span>
              </div>
            )}
            {!totals && (
              <div style={{ fontSize: 13, color: '#aaa' }}>Exact total calculated at checkout</div>
            )}
          </div>
        </div>
      </>
    )
  }

  function PaymentStep() {
    if (!user) {
      return (
        <>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Log in to Pay</h2>
          <p style={{ fontSize: 14, color: '#666', margin: '0 0 24px' }}>Sign in to your FamilyMeal account to complete your order.</p>
          <form onSubmit={handleLogin} style={{ maxWidth: 380 }}>
            <div style={{ marginBottom: 14 }}>
              <label style={labelSt}>Email</label>
              <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} required autoComplete="email"
                style={inputSt} placeholder="you@example.com" />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={labelSt}>Password</label>
              <input type="password" value={loginPw} onChange={e => setLoginPw(e.target.value)} required autoComplete="current-password"
                style={inputSt} placeholder="••••••••" />
            </div>
            {loginError && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 14 }}>{loginError}</div>}
            <button type="submit" disabled={loginLoading}
              style={{ ...nextBtn, width: '100%', opacity: loginLoading ? 0.7 : 1, cursor: loginLoading ? 'not-allowed' : 'pointer' }}>
              {loginLoading ? 'Logging in…' : 'Log In & Continue'}
            </button>
          </form>
        </>
      )
    }

    return (
      <>
        <h2 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Payment</h2>
        <p style={{ fontSize: 14, color: '#666', margin: '0 0 24px' }}>Ordering as {user.firstName} {user.lastName}</p>

        {savedCard ? (
          <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', padding: '18px 22px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 10 }}>Saved payment method</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 28 }}>💳</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>
                  {savedCard.brand || savedCard.cardBrand || 'Card'} ···· {savedCard.last4 || savedCard.lastFour || '••••'}
                </div>
                {(savedCard.expMonth || savedCard.exp_month) && (
                  <div style={{ fontSize: 12, color: '#888' }}>Exp {savedCard.expMonth || savedCard.exp_month}/{String(savedCard.expYear || savedCard.exp_year).slice(-2)}</div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ background: '#fff', borderRadius: 14, border: '1.5px solid #f0f0f0', padding: '18px 22px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 12 }}>Card details</div>
            {stripeKey
              ? <div ref={cardRef} style={{ padding: '10px 2px', minHeight: 20 }} />
              : <div style={{ fontSize: 13, color: '#aaa' }}>Loading secure payment form…</div>
            }
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f8f8fc', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
          <span style={{ fontSize: 16 }}>🔒</span>
          <span style={{ fontSize: 12, color: '#777' }}>Payments are processed securely by Stripe. Card details never touch our servers.</span>
        </div>

        {totalCents > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', borderTop: '1px solid #f0f0f0', fontSize: 16, fontWeight: 700, color: DARK }}>
            <span>Total due today</span><span>{totalDisplay}</span>
          </div>
        )}
      </>
    )
  }

  function DoneStep() {
    const ref = confirmation?.reference || confirmation?.orderReference || orderRef
    return (
      <div style={{ textAlign: 'center', padding: '32px 0' }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
        <h2 style={{ fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 10px' }}>Order Confirmed!</h2>
        <p style={{ fontSize: 15, color: '#666', margin: '0 0 6px' }}>
          Your catering from <strong>{restaurant.name}</strong> is confirmed.
        </p>
        {ref && <p style={{ fontSize: 13, color: '#aaa', margin: '0 0 32px' }}>Order #{ref}</p>}
        <div style={{ background: '#fff', borderRadius: 16, border: '1.5px solid #f0f0f0', padding: '22px', maxWidth: 420, margin: '0 auto 32px', textAlign: 'left' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              ['Package', pkg?.name || ''],
              ['Date', new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })],
              ['Guests', `${headcount} people`],
              ['Delivery', `${addr.city}, ${addr.state}`],
            ].map(([label, val]) => (
              <div key={label}>
                <div style={{ fontSize: 12, color: '#aaa', marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{val}</div>
              </div>
            ))}
          </div>
          {totalCents > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 800, color: DARK }}>
              <span>Total charged</span><span>{totalDisplay}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/portal" style={{ padding: '12px 24px', background: BLUE, color: '#fff', borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none', boxShadow: '0 4px 12px rgba(91,111,232,0.25)' }}>
            View My Orders
          </Link>
          <Link href="/fullmap" style={{ padding: '12px 24px', background: '#f0f0f0', color: DARK, borderRadius: 12, fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>
            Browse More
          </Link>
        </div>
      </div>
    )
  }

  // ── Can proceed? ────────────────────────────────────────────────────────────
  function canNext() {
    if (loading) return false
    switch (step) {
      case 'date': return !!date
      case 'time': return !!time
      case 'details': return !!(addr.line1 && addr.city && addr.state && addr.zipCode)
      case 'review': return true
      case 'payment': return !!user
      default: return false
    }
  }

  function goNext() {
    setError('')
    if (step === 'details') { proceedToReview(); return }
    if (step === 'payment') { handlePlaceOrder(); return }
    const idx = FLOW.indexOf(step)
    if (idx >= 0 && idx < FLOW.length - 1) setStep(FLOW[idx + 1])
  }

  function goBack() {
    setError('')
    const idx = FLOW.indexOf(step)
    if (idx > 0) setStep(FLOW[idx - 1])
  }

  const nextLabel: Partial<Record<Step, string>> = {
    date: 'Choose Time →',
    time: 'Add Details →',
    details: loading ? 'Calculating…' : 'Review Order →',
    review: 'Proceed to Payment →',
    payment: loading ? 'Placing Order…' : (totalCents > 0 ? `Pay ${totalDisplay} →` : 'Place Order →'),
  }

  // ── Progress bar ────────────────────────────────────────────────────────────
  const curIdx = FLOW.indexOf(step)

  return (
    <div style={{ minHeight: '100svh', background: '#f8f8fc', fontFamily: F }}>
      <GlobalHeader />

      {/* Progress */}
      {step !== 'done' && (
        <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '14px 24px' }}>
          <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', alignItems: 'center' }}>
            {FLOW.map((s, i) => {
              const done = i < curIdx
              const active = i === curIdx
              return (
                <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < FLOW.length - 1 ? 1 : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: done ? BLUE : active ? 'linear-gradient(135deg,#6B6EF9,#F0468A)' : '#f0f0f0',
                      color: (done || active) ? '#fff' : '#aaa', fontSize: 11, fontWeight: 700, flexShrink: 0,
                    }}>
                      {done ? '✓' : i + 1}
                    </div>
                    <span className="step-lbl" style={{ fontSize: 11, color: active ? DARK : done ? '#666' : '#bbb', fontWeight: active ? 700 : 400, whiteSpace: 'nowrap' }}>
                      {STEP_LABEL[s]}
                    </span>
                  </div>
                  {i < FLOW.length - 1 && <div style={{ flex: 1, height: 1.5, background: done ? BLUE : '#eee', margin: '0 8px' }} />}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Restaurant bar */}
      {step !== 'done' && (
        <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f0', padding: '8px 24px' }}>
          <div style={{ maxWidth: 700, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href={`/restaurants/${slug}`} style={{ fontSize: 13, color: '#888', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              ← {restaurant.name}
            </Link>
            {pkg && step !== 'package' && (
              <><span style={{ color: '#ddd', fontSize: 16 }}>|</span><span style={{ fontSize: 13, color: '#555' }}>{pkg.name}</span></>
            )}
          </div>
        </div>
      )}

      {/* Main */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '40px 24px 80px' }}>
        {error && (
          <div style={{ background: '#FEF2F2', border: '1.5px solid #FCA5A5', borderRadius: 12, padding: '13px 16px', marginBottom: 24, color: '#991B1B', fontSize: 14 }}>
            {error}
          </div>
        )}

        {step === 'package' && <PackageStep />}
        {step === 'date' && <DateStep />}
        {step === 'time' && <TimeStep />}
        {step === 'details' && <DetailsStep />}
        {step === 'review' && <ReviewStep />}
        {step === 'payment' && <PaymentStep />}
        {step === 'done' && <DoneStep />}

        {step !== 'done' && step !== 'package' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 44, paddingTop: 24, borderTop: '1px solid #efefef' }}>
            <button onClick={goBack} disabled={loading} style={backBtn}>← Back</button>
            <button onClick={goNext} disabled={!canNext()}
              style={{ ...nextBtn, opacity: canNext() ? 1 : 0.45, cursor: canNext() ? 'pointer' : 'not-allowed' }}>
              {nextLabel[step] ?? 'Continue →'}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        input:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.12); }
        button:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 2px; }
        @media (max-width: 640px) {
          .step-lbl { display: none; }
        }
      `}</style>
    </div>
  )
}
