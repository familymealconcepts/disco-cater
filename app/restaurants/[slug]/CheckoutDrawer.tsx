'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthContext } from '../../context/AuthContext'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

declare global { interface Window { Stripe?: (key: string) => any } }

// ── Types ──────────────────────────────────────────────────────────────────────
interface FmPackage {
  reference: string; name: string; price: number
  serves?: string | number | null
  image?: { reference: string } | null
}
interface CartItem { pkg: FmPackage; quantity: number }
interface FmDeliveryAddr { addressLine1: string; city: string; state: string; zipcode: string }

interface Props {
  fmRef: string
  fmSlug: string | null
  restaurantName: string
  cart: CartItem[]
  selDate: string
  selTime: string
  orderType: 'PICKUP' | 'DELIVERY'
  addr: { line1: string; city: string; state: string; zip: string }
  subtotal: number
  tipAmt: number
  svcAmt: number
  minOrder: number
  onClose: () => void
}

type DrawerStep = 'review' | 'auth' | 'processing' | 'payment' | 'placing'

function fmt$(n: number) { return `$${n % 1 === 0 ? n : n.toFixed(2)}` }
function fmtDateShort(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) } catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CheckoutDrawer({
  fmRef, fmSlug, restaurantName, cart, selDate, selTime, orderType,
  addr, subtotal, tipAmt, svcAmt, minOrder, onClose,
}: Props) {
  const router = useRouter()

  // Auth state from context
  const { user: authUser } = useAuthContext()
  const [user, setUser] = useState<any>(null)

  // Checkout flow
  const [step, setStep] = useState<DrawerStep>('review')
  const [orderRef, setOrderRef] = useState('')
  const [fmTotals, setFmTotals] = useState<any>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  // Auth form
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authEmail, setAuthEmail] = useState('')
  const [authPw, setAuthPw] = useState('')
  const [authFirst, setAuthFirst] = useState('')
  const [authLast, setAuthLast] = useState('')
  const [authPhone, setAuthPhone] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  // Stripe
  const [stripeKey, setStripeKey] = useState('')
  const [savedCard, setSavedCard] = useState<any>(null)
  const [useNewCard, setUseNewCard] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  // Sync user from AuthContext
  useEffect(() => {
    if (authUser) setUser(authUser)
  }, [authUser])

  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 3500)
    return () => clearTimeout(t)
  }, [toast])

  // Load Stripe + saved card when entering payment step
  useEffect(() => {
    if (step !== 'payment') return
    fetch('/api/order/stripe-info')
      .then(r => r.json())
      .then(d => setStripeKey(d.publishableKey || d.publicKey || d.stripePublishableKey || d.key || ''))
      .catch(() => {})
    fetch('/api/order/saved-card')
      .then(r => r.json())
      .then(d => { if (d && !d.error && (d.brand || d.last4 || d.cardBrand || d.lastFour)) setSavedCard(d) })
      .catch(() => {})
  }, [step])

  // Mount Stripe card element
  useEffect(() => {
    if (step !== 'payment' || !stripeKey || (savedCard && !useNewCard) || !cardRef.current) return
    const mount = () => {
      if (!window.Stripe || !cardRef.current || cardElRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      cardElRef.current = elements.create('card', {
        style: { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#bbb' } } },
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
  }, [step, stripeKey, savedCard, useNewCard])

  // ── Computed ───────────────────────────────────────────────────────────────
  const displayTotal = fmTotals
    ? (fmTotals.total ?? fmTotals.totalAmount ?? fmTotals.totalCost ?? subtotal + tipAmt + svcAmt)
    : subtotal + tipAmt + svcAmt
  const displayDeliveryFee = fmTotals?.deliveryFee ?? fmTotals?.delivery ?? null
  const displayTax = fmTotals?.tax ?? fmTotals?.taxAmount ?? null
  const displayTips = fmTotals?.tips ?? tipAmt
  const displaySvc = fmTotals?.fee ?? svcAmt
  const fmAddr: FmDeliveryAddr = {
    addressLine1: addr.line1,
    city: addr.city,
    state: addr.state,
    zipcode: addr.zip,
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    setAuthLoading(true); setAuthError('')
    try {
      const body = authMode === 'register'
        ? { action: 'register', email: authEmail, password: authPw, firstName: authFirst, lastName: authLast, phoneNumber: authPhone }
        : { action: 'login', email: authEmail, password: authPw }
      const res = await fetch('/api/fm-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) { setAuthError(data.error || 'Authentication failed.'); setAuthLoading(false); return }
      const displayData = { email: data.email, firstName: data.firstName, lastName: data.lastName, phoneNumber: data.phoneNumber, reference: data.reference, role: data.role }
      setUser(displayData)
      setAuthLoading(false)
      processOrder(displayData)
    } catch { setAuthError('Unable to connect. Please try again.'); setAuthLoading(false) }
  }

  async function processOrder(authedUser?: any) {
    setStep('processing'); setError('')
    const currentUser = authedUser || user
    if (!currentUser) { setStep('auth'); return }

    try {
      // 1. Init order
      const initBody = {
        restaurantRef: fmRef,
        mealPackages: cart.map(i => ({ reference: i.pkg.reference, quantity: i.quantity })),
        orderType,
        orderDate: selDate,
        orderTime: selTime,
        ...(orderType === 'DELIVERY' ? { deliveryAddress: fmAddr } : {}),
      }
      const initRes = await fetch('/api/order/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initBody),
      })
      const initData = await initRes.json()
      if (!initRes.ok) throw new Error(initData.error || initData.message || 'Failed to create order draft.')
      const ref = initData.reference || initData.orderReference || initData.orderRef || initData.id || ''
      if (!ref) throw new Error('Order created but no reference returned.')
      setOrderRef(ref)

      // 2. Slot selected (non-blocking)
      fetch('/api/fm-slot-selected', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantRef: fmRef, orderRef: ref, localDate: selDate, localTime: selTime, orderType }),
      }).catch(() => {})

      // 3. Validate delivery address (non-blocking)
      if (orderType === 'DELIVERY') {
        fetch('/api/order/validate-address', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantReference: fmRef, deliveryAddress: fmAddr }),
        }).catch(() => {})
      }

      // 4. Update order to get real totals (best-effort — FM PUT may return 500)
      try {
        const updRes = await fetch('/api/order/update', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantRef: fmRef, orderRef: ref,
            tips: tipAmt, tipsType: 'DOLLAR',
            ...(orderType === 'DELIVERY' ? { deliveryAddress: fmAddr } : {}),
          }),
        })
        const updData = await updRes.json()
        if (updRes.ok && !updData.error) setFmTotals(updData)
      } catch {}

      setStep('payment')
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStep('review')
    }
  }

  async function handlePlaceOrder() {
    if (!user) return
    setStep('placing'); setError('')

    try {
      // Stripe tokenize
      let stripeToken: string | null = null
      const usingSavedCard = savedCard && !useNewCard
      if (!usingSavedCard) {
        if (!stripeRef.current || !cardElRef.current) {
          setError('Payment form not ready. Please wait and try again.')
          setStep('payment'); return
        }
        const result = await stripeRef.current.createToken(cardElRef.current)
        if (result.error) { setError(result.error.message || 'Card error.'); setStep('payment'); return }
        stripeToken = result.token?.id ?? null
      }

      // Confirm payment
      const confRes = await fetch('/api/order/confirm-payment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderReference: orderRef, token: stripeToken, useDefaultPayment: usingSavedCard, restaurantReference: fmRef }),
      })
      const confData = await confRes.json()
      if (!confRes.ok && confData.error) throw new Error(confData.error || confData.message || 'Payment failed.')

      // Place order
      const placeRes = await fetch('/api/order/place', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantRef: fmRef, orderRef }),
      })
      const placeData = await placeRes.json()
      if (!placeRes.ok && placeData.error) throw new Error(placeData.error || placeData.message || 'Failed to place order.')

      const finalRef = placeData.reference || placeData.orderReference || orderRef
      router.push(`/order-confirmation/${finalRef}`)
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStep('payment')
    }
  }

  // ── Step: Review ───────────────────────────────────────────────────────────
  function ReviewStep() {
    const canProceed = cart.length > 0 && !!selDate && !!selTime && (orderType === 'PICKUP' || (!!addr.line1 && !!addr.city && !!addr.state && !!addr.zip))
    return (
      <>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>Review Your Order</h2>
          <div style={{ fontSize: 13, color: '#888' }}>{restaurantName}</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
          {/* Date/time/type */}
          <div style={{ padding: '16px 0', borderBottom: '1px solid #f4f4f4' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {selDate && <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtDateShort(selDate)}</span>}
              {selTime && <><span style={{ color: '#ddd' }}>·</span><span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtTime(selTime)}</span></>}
              <span style={{ color: '#ddd' }}>·</span>
              <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: orderType === 'PICKUP' ? '#EEF0FD' : '#F0FDF4', color: orderType === 'PICKUP' ? INDIGO : '#166534' }}>
                {orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}
              </span>
            </div>
            {orderType === 'DELIVERY' && addr.line1 && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>📍 {addr.line1}, {addr.city}, {addr.state} {addr.zip}</div>
            )}
          </div>

          {/* Items */}
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f4f4f4' }}>
            {cart.map(item => (
              <div key={item.pkg.reference} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{item.quantity > 1 && <span style={{ color: '#888' }}>{item.quantity}× </span>}{item.pkg.name}</div>
                  {item.pkg.serves && <div style={{ fontSize: 11, color: '#aaa' }}>Serves {item.pkg.serves}</div>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK, flexShrink: 0, marginLeft: 12 }}>{fmt$(item.pkg.price * item.quantity)}</div>
              </div>
            ))}
          </div>

          {/* Pricing */}
          <div style={{ padding: '14px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 6 }}>
              <span>Subtotal</span><span style={{ fontWeight: 600, color: DARK }}>{fmt$(subtotal)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 6 }}>
              <span>Delivery fee</span>
              {orderType === 'PICKUP'
                ? <span style={{ color: '#22C55E', fontWeight: 600 }}>Free</span>
                : <span style={{ color: '#aaa', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>}
            </div>
            {svcAmt > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 6 }}>
                <span>Service fee</span><span style={{ fontWeight: 600, color: DARK }}>{fmt$(svcAmt)}</span>
              </div>
            )}
            {tipAmt > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 6 }}>
                <span>Tip</span><span style={{ fontWeight: 600, color: DARK }}>{fmt$(tipAmt)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 14 }}>
              <span>Tax</span><span style={{ color: '#aaa', fontSize: 12, fontStyle: 'italic' }}>Calculated at checkout</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '2px solid #f0f0f0', paddingTop: 12, fontSize: 17, fontWeight: 800, color: DARK }}>
              <span>Estimated Total</span><span>{fmt$(subtotal + tipAmt + svcAmt)}</span>
            </div>
            {orderType === 'DELIVERY' && <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 2 }}>+ delivery & tax</div>}
          </div>

          {!canProceed && (
            <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 10, padding: '10px 14px', marginBottom: 8, fontSize: 13, color: '#92400E' }}>
              {!selDate && '📅 Please select a date and time before checking out.'}
              {selDate && !selTime && '⏰ Please select a pickup time before checking out.'}
              {selDate && selTime && orderType === 'DELIVERY' && !addr.line1 && '📍 Please enter a delivery address before checking out.'}
            </div>
          )}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0' }}>
          <button onClick={() => user ? processOrder() : setStep('auth')} disabled={!canProceed}
            style={{ width: '100%', padding: '14px', background: canProceed ? BLUE : '#e8e8e8', color: canProceed ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: canProceed ? 'pointer' : 'default', fontFamily: F, boxShadow: canProceed ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
            {user ? `Continue as ${user.firstName} →` : 'Continue to Login →'}
          </button>
          {!user && (
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: '#aaa' }}>
              You'll log in or create an account on the next step
            </div>
          )}
        </div>
      </>
    )
  }

  // ── Step: Auth ─────────────────────────────────────────────────────────────
  function AuthStep() {
    return (
      <>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
            {authMode === 'login' ? 'Log in to continue' : 'Create an account'}
          </h2>
          <div style={{ fontSize: 13, color: '#888' }}>Required to place your order</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', background: '#f4f4f8', borderRadius: 10, padding: 3, marginBottom: 22, gap: 3 }}>
            {(['login', 'register'] as const).map(m => (
              <button key={m} onClick={() => { setAuthMode(m); setAuthError('') }}
                style={{ flex: 1, padding: '9px', border: 'none', borderRadius: 8, cursor: 'pointer', fontFamily: F, fontSize: 13, fontWeight: authMode === m ? 700 : 500, background: authMode === m ? '#fff' : 'transparent', color: authMode === m ? DARK : '#999', boxShadow: authMode === m ? '0 1px 4px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.12s' }}>
                {m === 'login' ? 'Log In' : 'Sign Up'}
              </button>
            ))}
          </div>

          <form onSubmit={handleAuth} id="auth-form">
            {authMode === 'register' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={labelSt}>First name</label>
                  <input value={authFirst} onChange={e => setAuthFirst(e.target.value)} required placeholder="Jane" style={inputSt} />
                </div>
                <div>
                  <label style={labelSt}>Last name</label>
                  <input value={authLast} onChange={e => setAuthLast(e.target.value)} required placeholder="Smith" style={inputSt} />
                </div>
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={labelSt}>Email</label>
              <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} required autoComplete="email" placeholder="you@example.com" style={inputSt} />
            </div>
            <div style={{ marginBottom: authMode === 'register' ? 12 : 20 }}>
              <label style={labelSt}>Password</label>
              <input type="password" value={authPw} onChange={e => setAuthPw(e.target.value)} required autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} placeholder="••••••••" style={inputSt} />
            </div>
            {authMode === 'register' && (
              <div style={{ marginBottom: 20 }}>
                <label style={labelSt}>Phone (optional)</label>
                <input type="tel" value={authPhone} onChange={e => setAuthPhone(e.target.value)} placeholder="+1 (555) 000-0000" style={inputSt} />
              </div>
            )}
            {authError && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 14, padding: '10px 12px', background: '#FEF2F2', borderRadius: 8 }}>{authError}</div>}
          </form>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0' }}>
          <button type="submit" form="auth-form" disabled={authLoading}
            style={{ width: '100%', padding: '14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: authLoading ? 'not-allowed' : 'pointer', fontFamily: F, opacity: authLoading ? 0.7 : 1, boxShadow: '0 4px 14px rgba(91,111,232,0.25)' }}>
            {authLoading ? (authMode === 'login' ? 'Logging in…' : 'Creating account…') : (authMode === 'login' ? 'Log In & Continue →' : 'Create Account & Continue →')}
          </button>
          <button onClick={() => setStep('review')} style={{ width: '100%', marginTop: 10, padding: '10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#888', fontFamily: F }}>← Back to review</button>
        </div>
      </>
    )
  }

  // ── Step: Processing ───────────────────────────────────────────────────────
  function ProcessingStep() {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', border: `3px solid ${BLUE}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', marginBottom: 20 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 6 }}>Setting up your order…</div>
        <div style={{ fontSize: 13, color: '#888', textAlign: 'center' }}>Confirming availability and calculating totals</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ── Step: Payment ──────────────────────────────────────────────────────────
  function PaymentStep() {
    const fmSubtotal = fmTotals?.subtotal ?? fmTotals?.subTotal ?? subtotal
    const payTotal = fmTotals
      ? (fmTotals.total ?? fmTotals.totalAmount ?? fmTotals.totalCost ?? subtotal + tipAmt + svcAmt)
      : subtotal + tipAmt + svcAmt

    return (
      <>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>Payment</h2>
          {user && <div style={{ fontSize: 13, color: '#888' }}>Placing order as {user.firstName} {user.lastName}</div>}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {/* Totals from FM (or client-side estimate) */}
          <div style={{ background: '#fafafa', borderRadius: 12, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
              <span>Subtotal</span><span>{fmt$(fmSubtotal)}</span>
            </div>
            {displayDeliveryFee !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span>Delivery fee</span>
                {displayDeliveryFee === 0
                  ? <span style={{ color: '#22C55E', fontWeight: 600 }}>Free</span>
                  : <span>{fmt$(displayDeliveryFee)}</span>}
              </div>
            )}
            {displaySvc > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span>Service fee</span><span>{fmt$(displaySvc)}</span>
              </div>
            )}
            {displayTips > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span>Tip</span><span>{fmt$(displayTips)}</span>
              </div>
            )}
            {displayTax !== null && displayTax > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span>Tax</span><span>{fmt$(displayTax)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1.5px solid #ebebeb', paddingTop: 10, marginTop: 6, fontSize: 17, fontWeight: 800, color: DARK }}>
              <span>Total</span><span>{fmt$(payTotal)}</span>
            </div>
            {!fmTotals && <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 2 }}>Estimate — final total confirmed at payment</div>}
          </div>

          {/* Saved card or new card */}
          {savedCard && !useNewCard ? (
            <div>
              <div style={{ background: '#fff', border: '1.5px solid #f0f0f0', borderRadius: 12, padding: '14px 18px', marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Saved card</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 26 }}>💳</span>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{savedCard.brand || savedCard.cardBrand || 'Card'} ···· {savedCard.last4 || savedCard.lastFour || '••••'}</div>
                    {(savedCard.expMonth || savedCard.exp_month) && (
                      <div style={{ fontSize: 12, color: '#888' }}>Expires {savedCard.expMonth || savedCard.exp_month}/{String(savedCard.expYear || savedCard.exp_year || '').slice(-2)}</div>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={() => setUseNewCard(true)} style={{ fontSize: 13, color: BLUE, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F, padding: '4px 0', marginBottom: 16 }}>
                Use a different card →
              </button>
            </div>
          ) : (
            <div style={{ background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Card details</div>
              {stripeKey
                ? <div ref={cardRef} style={{ padding: '8px 2px', minHeight: 20 }} />
                : <div style={{ fontSize: 13, color: '#aaa', padding: '8px 0' }}>Loading secure payment form…</div>}
              {savedCard && (
                <button onClick={() => setUseNewCard(false)} style={{ fontSize: 13, color: '#888', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F, padding: '8px 0 0', display: 'block' }}>
                  ← Use saved card
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#f8f8fc', borderRadius: 10, padding: '11px 14px', marginBottom: 4 }}>
            <span style={{ fontSize: 16 }}>🔒</span>
            <span style={{ fontSize: 12, color: '#777', lineHeight: 1.4 }}>Payments processed securely by Stripe. Your card details never touch our servers.</span>
          </div>
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0' }}>
          {error && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, padding: '10px 12px', marginBottom: 12, color: '#991B1B', fontSize: 13 }}>{error}</div>
          )}
          <button onClick={handlePlaceOrder}
            style={{ width: '100%', padding: '14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 14px rgba(91,111,232,0.25)', transition: 'all 0.15s' }}>
            Pay {fmt$(payTotal)} →
          </button>
          <button onClick={() => setStep('review')} style={{ width: '100%', marginTop: 10, padding: '10px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#888', fontFamily: F }}>← Edit order</button>
        </div>
      </>
    )
  }

  // ── Step: Placing ──────────────────────────────────────────────────────────
  function PlacingStep() {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', border: `3px solid ${BLUE}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', marginBottom: 20 }} />
        <div style={{ fontSize: 16, fontWeight: 700, color: DARK, marginBottom: 6 }}>Placing your order…</div>
        <div style={{ fontSize: 13, color: '#888', textAlign: 'center' }}>Please don't close this window</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  // ── Shared styles ──────────────────────────────────────────────────────────
  const inputSt: React.CSSProperties = { width: '100%', padding: '11px 13px', border: '1.5px solid #e8e8e8', borderRadius: 9, fontSize: 14, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
  const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 5 }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop */}
      <div onClick={step === 'placing' ? undefined : onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 800 }} />

      {/* Drawer */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: '100%', maxWidth: 500,
        background: '#fff', zIndex: 801, display: 'flex', flexDirection: 'column',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.18)',
        animation: 'slideIn 0.25s ease-out',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid #f0f0f0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>Checkout</span>
            <span style={{ fontSize: 12, color: '#ddd' }}>·</span>
            <span style={{ fontSize: 12, color: '#888' }}>{restaurantName}</span>
          </div>
          {step !== 'placing' && (
            <button onClick={onClose} style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>×</button>
          )}
        </div>

        {/* Error banner (for review/payment steps) */}
        {error && step === 'review' && (
          <div style={{ padding: '10px 24px', background: '#FEF2F2', borderBottom: '1px solid #FCA5A5', color: '#991B1B', fontSize: 13 }}>{error}</div>
        )}

        {/* Step content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {step === 'review' && <ReviewStep />}
          {step === 'auth' && <AuthStep />}
          {step === 'processing' && <ProcessingStep />}
          {step === 'payment' && <PaymentStep />}
          {step === 'placing' && <PlacingStep />}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: DARK, color: '#fff', padding: '12px 20px', borderRadius: 12, fontSize: 14, fontWeight: 600, zIndex: 900, boxShadow: '0 8px 24px rgba(0,0,0,0.2)', whiteSpace: 'nowrap' }}>
          {toast}
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        input:focus { border-color: ${BLUE} !important; box-shadow: 0 0 0 3px rgba(91,111,232,0.1) !important; }
        @media (max-width: 520px) { .checkout-drawer { max-width: 100% !important; } }
      `}</style>
    </>
  )
}
