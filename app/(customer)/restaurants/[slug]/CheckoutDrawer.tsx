'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuthContext } from '../../../context/AuthContext'
import { buildCheckoutPayload } from '../../../../lib/pricing/checkout'
import { cartLineTotal, cartSubtotal } from '../../../../lib/pricing/cart'
import { formatCurrency } from '../../../../lib/pricing/lineItem'

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
interface CartAddOn {
  reference: string
  name: string
  price: number
  count: number
  extraItemsGroupReference: string
}
interface CartItem {
  lineId: string
  pkg: FmPackage
  quantity: number
  note?: string
  addOns: CartAddOn[]
  unitPrice: number
}
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
  // Optional headcount captured upstream. If null, the review step shows
  // an inline prompt so we can still ask — Skip is allowed.
  headcount: number | null
  onHeadcount: (n: number | null) => void
  onClose: () => void
}

type DrawerStep = 'review' | 'processing' | 'payment' | 'placing'

function fmt$(n: number) { return `$${n.toFixed(2)}` }
function fmtDateShort(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) } catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CheckoutDrawer({
  fmRef, fmSlug, restaurantName, cart, selDate, selTime, orderType,
  addr, subtotal, tipAmt, svcAmt, minOrder, headcount, onHeadcount, onClose,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const debugPricing = searchParams?.get('debug') === 'pricing'
  const { user: authUser, openAuthModal } = useAuthContext()

  // Checkout flow
  const [step, setStep] = useState<DrawerStep>('review')
  const [orderRef, setOrderRef] = useState('')
  const [fmTotals, setFmTotals] = useState<any>(null)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [waitingForAuth, setWaitingForAuth] = useState(false)
  // Inline headcount prompt — shown only when the user reaches checkout
  // without having entered a number upstream, and they haven't already
  // skipped it during this session.
  const [headcountInput, setHeadcountInput] = useState<string>('')
  const [headcountSkipped, setHeadcountSkipped] = useState(false)

  // Stripe
  const [stripeKey, setStripeKey] = useState('')
  const [savedCard, setSavedCard] = useState<any>(null)
  const [useNewCard, setUseNewCard] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const cardElRef = useRef<any>(null)

  // Continue checkout after login via AuthModal
  useEffect(() => {
    if (waitingForAuth && authUser) {
      setWaitingForAuth(false)
      processOrder()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, waitingForAuth])

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
    const envKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (envKey) {
      setStripeKey(envKey)
    } else {
      fetch('/api/order/stripe-info')
        .then(r => r.json())
        .then(d => setStripeKey(d.publishableKey || d.publicKey || d.stripePublishableKey || d.key || ''))
        .catch(() => {})
    }
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

  async function processOrder() {
    setStep('processing'); setError('')
    if (!authUser) { setWaitingForAuth(true); openAuthModal(undefined, 'login'); return }

    try {
      // 1. Init order — payload built via lib/pricing/checkout.ts to
      // centralize the FM POST shape. See doc § 1.3 for citations:
      // mealPackages[].count + extraItems[]{ count, type: 'ADD_ON',
      // extraItemsGroupReference }. Field shape unchanged from the
      // previous inline version.
      const initBody = buildCheckoutPayload({
        restaurantRef: fmRef,
        cart: cart.map(i => ({
          reference: i.pkg.reference,
          price: i.pkg.price,
          count: i.quantity,
          addOns: i.addOns,
          note: i.note,
        })),
        orderType: orderType as 'DELIVERY' | 'PICKUP',
        orderDate: selDate,
        orderTime: selTime,
        deliveryAddress: orderType === 'DELIVERY' ? fmAddr : undefined,
        headcount,
      })
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

      // 4. Update order to get real totals (best-effort)
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
    if (!authUser) return
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

      // Save address silently (post-order)
      if (orderType === 'DELIVERY' && addr.line1) {
        fetch('/api/fm-user-addresses', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr.line1, city: addr.city, state: addr.state, zipCode: addr.zip }),
        }).catch(() => {})
      }

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

          {/* Headcount prompt — inline, not a blocker */}
          {headcount == null && !headcountSkipped && (
            <div style={{ background: '#F5F4FF', border: '1px solid #E5E3FB', borderRadius: 10, padding: '12px 14px', margin: '12px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 8 }}>
                How many people are you feeding?
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number" inputMode="numeric" min={1}
                  value={headcountInput}
                  onChange={e => setHeadcountInput(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const n = parseInt(headcountInput, 10)
                      if (!isNaN(n) && n > 0) onHeadcount(n)
                    }
                  }}
                  placeholder="e.g. 40"
                  style={{ flex: 1, height: 38, border: '1.5px solid #e8e8e8', borderRadius: 8, padding: '0 10px', fontSize: 13, color: DARK, fontFamily: F, background: '#fff', outline: 'none' }}
                />
                <button onClick={() => {
                    const n = parseInt(headcountInput, 10)
                    if (!isNaN(n) && n > 0) onHeadcount(n)
                  }}
                  disabled={!headcountInput}
                  style={{ height: 38, padding: '0 14px', background: headcountInput ? INDIGO : '#e0e0e0', color: headcountInput ? '#fff' : '#aaa', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: headcountInput ? 'pointer' : 'default', fontFamily: F }}>
                  Save
                </button>
                <button onClick={() => setHeadcountSkipped(true)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#888', fontWeight: 600, fontFamily: F, padding: '6px 4px' }}>
                  Skip
                </button>
              </div>
            </div>
          )}

          {headcount != null && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f4f4f4' }}>
              <div style={{ fontSize: 13, color: '#555' }}>
                👥 {headcount} {headcount === 1 ? 'person' : 'people'}
              </div>
              <button onClick={() => { setHeadcountInput(String(headcount)); onHeadcount(null) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: '2px 6px' }}>
                Edit
              </button>
            </div>
          )}

          {/* Items */}
          <div style={{ padding: '12px 0', borderBottom: '1px solid #f4f4f4' }}>
            {cart.map(item => (
              <div key={item.lineId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{item.quantity > 1 && <span style={{ color: '#888' }}>{item.quantity}× </span>}{item.pkg.name}</div>
                  {item.pkg.serves && <div style={{ fontSize: 11, color: '#aaa' }}>Serves {item.pkg.serves}</div>}
                  {item.addOns.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {item.addOns.map(a => (
                        <div key={a.reference} style={{ fontSize: 11, color: '#888' }}>+ ({a.count}) {a.name}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK, flexShrink: 0, marginLeft: 12 }}>{fmt$(item.unitPrice * item.quantity)}</div>
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
            {orderType === 'DELIVERY' && <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 2 }}>+ delivery &amp; tax</div>}
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
          <button
            onClick={() => {
              if (authUser) {
                processOrder()
              } else {
                setWaitingForAuth(true)
                openAuthModal(undefined, 'login')
              }
            }}
            disabled={!canProceed}
            style={{ width: '100%', padding: '14px', background: canProceed ? BLUE : '#e8e8e8', color: canProceed ? '#fff' : '#bbb', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: canProceed ? 'pointer' : 'default', fontFamily: F, boxShadow: canProceed ? '0 4px 14px rgba(91,111,232,0.25)' : 'none', transition: 'all 0.15s' }}>
            {authUser ? `Continue as ${authUser.firstName} →` : 'Continue to Login →'}
          </button>
          {!authUser && (
            <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: '#aaa' }}>
              You&apos;ll log in or create an account on the next step
            </div>
          )}
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
          {authUser && <div style={{ fontSize: 13, color: '#888' }}>Placing order as {authUser.firstName} {authUser.lastName}</div>}
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
        <div style={{ fontSize: 13, color: '#888', textAlign: 'center' }}>Please don&apos;t close this window</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

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

        {/* Error banner (for review step) */}
        {error && step === 'review' && (
          <div style={{ padding: '10px 24px', background: '#FEF2F2', borderBottom: '1px solid #FCA5A5', color: '#991B1B', fontSize: 13 }}>{error}</div>
        )}

        {/* Step content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {step === 'review' && <ReviewStep />}
          {step === 'processing' && <ProcessingStep />}
          {step === 'payment' && <PaymentStep />}
          {step === 'placing' && <PlacingStep />}
        </div>
      </div>

      {/* Debug overlay (?debug=pricing) — surface cart math + the POST
          payload before it's sent so reconciliation is visible. Hidden
          unless the URL has ?debug=pricing. Never shown to real diners. */}
      {debugPricing && <PricingDebugOverlay
        cart={cart}
        subtotal={subtotal}
        svcAmt={svcAmt}
        tipAmt={tipAmt}
        fmRef={fmRef}
        orderType={orderType as 'DELIVERY' | 'PICKUP'}
        selDate={selDate}
        selTime={selTime}
        addr={addr}
        headcount={headcount}
      />}

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

// ── Pricing debug overlay (hidden unless ?debug=pricing) ─────────────────────
// Mounts a fixed panel on the bottom-left of the viewport that lists
// every cart line with its lib/pricing/cart.cartLineTotal, the running
// subtotal, the service/tip estimates, and a JSON preview of the FM
// POST payload that buildCheckoutPayload() would emit. Lets Peter
// reconcile against FM's PUT response without opening DevTools.

interface PricingDebugProps {
  cart: CartItem[]
  subtotal: number
  svcAmt: number
  tipAmt: number
  fmRef: string
  orderType: 'DELIVERY' | 'PICKUP'
  selDate: string
  selTime: string
  addr: Props['addr']
  headcount: number | null
}

function PricingDebugOverlay({ cart, subtotal, svcAmt, tipAmt, fmRef, orderType, selDate, selTime, addr, headcount }: PricingDebugProps) {
  const lineRows = cart.map((i, idx) => {
    const line = { price: i.pkg.price, count: i.quantity, addOns: i.addOns }
    const total = cartLineTotal(line)
    const sub = cartSubtotal([line])  // sanity check — should equal total for one line
    return { idx, name: i.pkg.name, qty: i.quantity, base: i.pkg.price, addOns: i.addOns, total, sub }
  })

  const computedSubtotal = cartSubtotal(cart.map(i => ({ price: i.pkg.price, count: i.quantity, addOns: i.addOns })))
  const subtotalMatches = Math.abs(computedSubtotal - subtotal) < 0.005

  const payload = buildCheckoutPayload({
    restaurantRef: fmRef,
    cart: cart.map(i => ({ reference: i.pkg.reference, price: i.pkg.price, count: i.quantity, addOns: i.addOns, note: i.note })),
    orderType,
    orderDate: selDate,
    orderTime: selTime,
    deliveryAddress: orderType === 'DELIVERY' && addr ? {
      addressLine1: addr.line1, city: addr.city, state: addr.state, zipcode: addr.zip,
    } : undefined,
    headcount,
  })

  return (
    <div style={{
      position: 'fixed', bottom: 16, left: 16, width: 420, maxHeight: '70vh',
      background: '#0d1117', color: '#c9d1d9', padding: '14px 16px',
      borderRadius: 10, border: '1px solid #30363d', zIndex: 950,
      boxShadow: '0 6px 24px rgba(0,0,0,0.3)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11, lineHeight: 1.45, overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ color: '#7ee787' }}>pricing.debug</strong>
        <span style={{ color: subtotalMatches ? '#7ee787' : '#f85149' }}>
          {subtotalMatches ? '✓ subtotal matches' : '✗ subtotal MISMATCH'}
        </span>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#8b949e', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.08em', marginBottom: 4 }}>Lines</div>
        {lineRows.map(r => (
          <div key={r.idx} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #21262d' }}>
            <div style={{ color: '#c9d1d9' }}>{r.name} × {r.qty}</div>
            <div style={{ color: '#8b949e', paddingLeft: 8 }}>base {formatCurrency(r.base)} × {r.qty} + Σ addons</div>
            {r.addOns.map((a, j) => (
              <div key={j} style={{ color: '#8b949e', paddingLeft: 16 }}>+ ({a.count}) {a.name} @ {formatCurrency(a.price)} = {formatCurrency(a.price * a.count)}/meal × {r.qty} meals</div>
            ))}
            <div style={{ color: '#7ee787', paddingLeft: 8 }}>line → {formatCurrency(r.total)}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#8b949e', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.08em', marginBottom: 4 }}>Totals (client estimate — FM PUT response is canonical)</div>
        <div>subtotal:       <span style={{ color: '#7ee787' }}>{formatCurrency(subtotal)}</span></div>
        <div>(helper sum):   <span style={{ color: subtotalMatches ? '#7ee787' : '#f85149' }}>{formatCurrency(computedSubtotal)}</span></div>
        <div>service charge: <span style={{ color: '#7ee787' }}>{formatCurrency(svcAmt)}</span></div>
        <div>tip:            <span style={{ color: '#7ee787' }}>{formatCurrency(tipAmt)}</span></div>
        <div>tax / delivery: <span style={{ color: '#8b949e' }}>server-computed</span></div>
      </div>

      <div>
        <div style={{ color: '#8b949e', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.08em', marginBottom: 4 }}>POST /api/order/init payload</div>
        <pre style={{ margin: 0, color: '#c9d1d9', fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
{JSON.stringify(payload, null, 2)}
        </pre>
      </div>
    </div>
  )
}
