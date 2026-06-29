'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuthContext } from '../../../context/AuthContext'
import { buildCheckoutPayload } from '../../../../lib/pricing/checkout'
import { cartLineTotal, cartSubtotal } from '../../../../lib/pricing/cart'
import { formatCurrency } from '../../../../lib/pricing/lineItem'
import { trackEvent } from '../../../../lib/analytics'
import { sanitizePhone, formatPhoneDisplay } from '../../../../lib/utils/phone'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const DARK = '#1A1028'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

// US state codes for the tax-exempt state dropdown.
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
]

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
interface FmDeliveryAddr { addressLine1: string; addressLine2?: string; city: string; state: string; zipcode: string; latitude?: number; longitude?: number; deliveryInstructions?: string }

interface Props {
  fmRef: string
  fmSlug: string | null
  restaurantName: string
  cart: CartItem[]
  selDate: string
  selTime: string
  orderType: 'PICKUP' | 'DELIVERY'
  addr: { line1: string; line2?: string; city: string; state: string; zip: string; lat?: number | null; lng?: number | null; instructions?: string }
  // Selected menu reference — required by FM's delivery validate contract.
  menuReference?: string | null
  subtotal: number
  tipAmt: number
  svcAmt: number
  minOrder: number
  // Optional headcount captured upstream. If null, the review step shows
  // an inline prompt so we can still ask — Skip is allowed.
  headcount: number | null
  onHeadcount: (n: number | null) => void
  // True only on the 1st-party /order/[slug] route. Selects the sourceoforder
  // wire value sent to FM ("FAMILYMEAL" when true → no lead-gen fee; "DISCO"
  // when false → 3P lead-gen fee). Defaults false so /restaurants/[slug] is
  // unchanged.
  isFirstParty?: boolean
  // Direct Entry: a restaurant admin placing on behalf of a customer (routed in
  // from /restaurant/orders/create?mode=direct-entry). Bypasses the customer
  // auth gate, places via the restaurant-authed proxy, and forces sourceoforder
  // FAMILYMEAL. method=invoice hides the card fields and sends a payment link
  // instead of charging; method=payment keeps the card UI but is gated.
  isDirectEntry?: boolean
  directEntryMethod?: 'payment' | 'invoice'
  // Close the drawer and reopen the order-setup modal so the diner can
  // re-validate a different delivery address. Falls back to onClose.
  onChangeAddress?: () => void
  // Notifies the parent when a Disco promo is applied/cleared so the
  // restaurant-page order summary can show the discount (display only). FM
  // coupons are not surfaced — they're priced by FM, not a Disco credit.
  onPromoChange?: (promo: { code: string; discountAmount: number } | null) => void
  onClose: () => void
}

type DrawerStep = 'processing' | 'payment' | 'placing' | 'sent'

// A promo is either a Disco code (display-only discount; refunded via Stripe
// after the order) or an FM coupon (sent as couponCode; FM computes the total).
type AppliedPromo =
  | { type: 'disco'; code: string; discountAmount: number }
  | { type: 'fm'; code: string }

// FM computes fee + tax server-side and returns them on the order PUT
// (checkoutPricesV2 → fee, stateSalesTaxInPrice, localSalesTaxInPrice,
// otherSalesTaxInPrice — checkout-sidebar-preview.component.ts:723-726). The
// public-api v2 PUT envelope varies, so read both flat and
// data.checkoutPublicResponseDto shapes; tax = state+local+other.
function extractFmMoney(raw: any): null | {
  subtotal: number | null; fee: number; tax: number; serviceCharge: number
  deliveryFee: number | null; tips: number | null; discount: number; total: number | null
} {
  if (!raw) return null
  const d = raw?.data?.checkoutPublicResponseDto ?? raw?.data ?? raw
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

function fmt$(n: number) { return `$${n.toFixed(2)}` }

const fieldLabel: React.CSSProperties = { fontSize: 11, color: '#888', fontWeight: 600, display: 'block', marginBottom: 4 }
const fieldBox: React.CSSProperties = { border: '1.5px solid #e8e8e8', borderRadius: 8, padding: '12px 12px', background: '#fff' }
function fmtDateShort(d: string) {
  try { return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) } catch { return d }
}
function fmtTime(t: string) {
  try { const [h, m] = t.split(':').map(Number); const dt = new Date(); dt.setHours(h, m); return dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) } catch { return t }
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CheckoutDrawer({
  fmRef, fmSlug, restaurantName, cart, selDate, selTime, orderType,
  addr, menuReference, subtotal, tipAmt, svcAmt, minOrder, headcount, onHeadcount,
  isFirstParty = false, isDirectEntry = false, directEntryMethod = 'payment',
  onChangeAddress, onPromoChange, onClose,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const debugPricing = searchParams?.get('debug') === 'pricing'
  const { user: authUser, openAuthModal } = useAuthContext()

  // Checkout flow
  const [step, setStep] = useState<DrawerStep>('payment')
  const [orderRef, setOrderRef] = useState('')
  const [fmTotals, setFmTotals] = useState<any>(null)
  // Tax Exempt Account. Handled entirely Disco-side: FM keeps the tax in its
  // total/PaymentIntent and /api/order/place reduces the PI by the tax amount
  // before payment is confirmed. The tax-exempt ID + state are persisted on
  // disco_orders for the receipt/PDF/portal.
  const [taxExemptId, setTaxExemptId] = useState('')
  const [taxExemptState, setTaxExemptState] = useState('')
  const [taxExemptApplied, setTaxExemptApplied] = useState(false)
  const [taxExemptOpen, setTaxExemptOpen] = useState(false)
  // Single unified promo entry. Disco codes (display-only discount + post-order
  // Stripe refund) are tried first; a 404 from /api/promo/validate falls back to
  // an FM coupon (couponCode in the FM payload — FM computes the discount).
  const [promoOpen, setPromoOpen] = useState(false)
  const [promoInput, setPromoInput] = useState('')
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null)
  const [promoLoading, setPromoLoading] = useState(false)
  const [promoError, setPromoError] = useState('')
  const [isFirstTimeUser, setIsFirstTimeUser] = useState(false)

  // Surface a Disco promo to the parent (restaurant-page order summary). FM
  // coupons are not a Disco credit, so they're reported as null. Display only —
  // the drawer keeps its own "full charge + note" behavior unchanged.
  useEffect(() => {
    if (!onPromoChange) return
    onPromoChange(appliedPromo?.type === 'disco'
      ? { code: appliedPromo.code, discountAmount: appliedPromo.discountAmount }
      : null)
  }, [appliedPromo, onPromoChange])
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
  // Bumped to force a destroy+remount of the Stripe Elements. After a declined
  // card in direct-entry payment, returning to the payment step would otherwise
  // leave the fields detached/unusable (the elements survive the placing step by
  // design, so they don't re-mount into the freshly-rendered divs on their own).
  const [cardResetKey, setCardResetKey] = useState(0)
  // Individual Stripe Elements (number / expiry / CVC) — clearer per-field
  // structure than the unified Card Element, and they don't render the Stripe
  // Link chip/prefill that the 'card' element does.
  const numberRef = useRef<HTMLDivElement>(null)
  const expiryRef = useRef<HTMLDivElement>(null)
  const cvcRef = useRef<HTMLDivElement>(null)
  const stripeRef = useRef<any>(null)
  const numberElRef = useRef<any>(null) // primary element for createToken
  const expiryElRef = useRef<any>(null)
  const cvcElRef = useRef<any>(null)
  // Direct-entry payment retry context: after a declined confirm, hold the
  // placed order + its PaymentIntent so the NEXT attempt re-confirms the SAME
  // PaymentIntent with a new card (FM's confirmOrderPaymentByPayStatement)
  // instead of re-placing the order — re-placing mints a second PaymentIntent
  // for the same orderRef and FM returns 409.
  const directEntryRetry = useRef<{ orderReference: string; paymentIntentId: string } | null>(null)

  // GA funnel guards — each fires at most once per drawer session. totalRef
  // holds the latest computed order total so the Stripe focus handler (whose
  // closure doesn't re-run on re-price) can read a fresh value. Direct Entry is
  // excluded from all funnel events (internal orders, not customer funnel data).
  const contactCompletedRef = useRef(false)
  const paymentStartedRef = useRef(false)
  const totalRef = useRef(0)

  // Contact fields — pre-filled from authUser but EDITABLE (customers often
  // order for someone else). Mirrors FM's customerInfoForm pattern in
  // checkout-customer-info.component.ts:195-204, 313-318. These values feed the
  // place body's `customer` object — NOT authUser directly.
  const [contactFirst, setContactFirst] = useState('')
  const [contactLast, setContactLast] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  // Optional company name — Disco-only (never sent to FM). Pre-filled from the
  // customer's saved profile when logged in; editable here.
  const [contactCompany, setContactCompany] = useState('')
  // Delivery instructions — editable at checkout, pre-filled from what was
  // entered in the order-setup modal. Flows into fmAddr → DTO + place body.
  const [deliveryNotes, setDeliveryNotes] = useState(() => addr.instructions || '')
  useEffect(() => {
    if (!authUser) return
    setContactFirst(p => p || authUser.firstName || '')
    setContactLast(p => p || authUser.lastName || '')
    setContactEmail(p => p || authUser.email || '')
    // Store digits-only internally (display is formatted, FM gets digits).
    setContactPhone(p => p || sanitizePhone(authUser.phoneNumber) || '')
    setContactCompany(p => p || authUser.companyName || '')
  }, [authUser])

  // GA funnel: contact details completed. Fires once when all four contact
  // fields are non-empty; later edits don't re-fire (the ref latches).
  useEffect(() => {
    if (isDirectEntry || contactCompletedRef.current) return
    if (contactFirst.trim() && contactLast.trim() && contactEmail.trim() && contactPhone.trim()) {
      contactCompletedRef.current = true
      trackEvent('checkout_contact_completed', { restaurant_name: restaurantName })
    }
  }, [contactFirst, contactLast, contactEmail, contactPhone, isDirectEntry, restaurantName])

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

  // Direct-entry invoice success → auto-return to the portal Orders list.
  useEffect(() => {
    if (step !== 'sent') return
    const t = setTimeout(() => router.push('/restaurant/orders'), 2500)
    return () => clearTimeout(t)
  }, [step, router])

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
    // Saved card: prefer the Disco-native vault (Stripe + Neon); fall back to
    // FM's defaultSource so existing FM customers still see their card. Both map
    // to the same shape the UI reads ({ brand/cardBrand, last4/lastFour, … }).
    const hasCard = (d: any) => d && !d.error && (d.brand || d.last4 || d.cardBrand || d.lastFour)
    fetch('/api/order/saved-card-disco')
      .then(r => r.json())
      .then(d => {
        if (hasCard(d)) { setSavedCard(d); return }
        return fetch('/api/order/saved-card')
          .then(r => r.json())
          .then(fm => { if (hasCard(fm)) setSavedCard(fm) })
      })
      .catch(() => {})
  }, [step])

  // Mount the three Stripe Elements once Stripe.js is ready. Kept entirely
  // separate from the pricing preview — preview loading/errors never touch
  // these refs, so the fields stay mounted (no "could not retrieve data").
  // Gated on paymentActive (payment OR placing), not step alone: the
  // payment→placing transition during Place Order must NOT re-run this effect's
  // cleanup, or it would destroy the Element while createToken is reading it.
  const paymentActive = step === 'payment' || step === 'placing'
  useEffect(() => {
    if (!paymentActive || !stripeKey || (savedCard && !useNewCard)) return
    const mount = () => {
      if (!window.Stripe || numberElRef.current) return
      if (!numberRef.current || !expiryRef.current || !cvcRef.current) return
      stripeRef.current = window.Stripe(stripeKey)
      const elements = stripeRef.current.elements()
      const style = { base: { fontFamily: F, fontSize: '15px', color: DARK, '::placeholder': { color: '#bbb' } } }
      // showIcon: false → no Stripe-rendered network/Link brand mark in the
      // field. disableLink: true → suppress Stripe Link's autofill badge that
      // injects a green "link" + Visa + last4 chip on the right of the field.
      // Cosmetic only; tokenization (createToken on numberElRef) is unaffected.
      numberElRef.current = elements.create('cardNumber', { style, showIcon: false, disableLink: true })
      // GA funnel: payment started — fires the first time the diner focuses the
      // card number field. Once per session; excludes Direct Entry.
      numberElRef.current.on('focus', () => {
        if (paymentStartedRef.current || isDirectEntry) return
        paymentStartedRef.current = true
        trackEvent('checkout_payment_started', { restaurant_name: restaurantName, total: totalRef.current })
      })
      expiryElRef.current = elements.create('cardExpiry', { style })
      cvcElRef.current = elements.create('cardCvc', { style })
      numberElRef.current.mount(numberRef.current)
      expiryElRef.current.mount(expiryRef.current)
      cvcElRef.current.mount(cvcRef.current)
    }
    let poll: ReturnType<typeof setInterval> | undefined
    if (window.Stripe) { mount() }
    else if (!document.getElementById('stripe-js')) {
      const s = document.createElement('script')
      s.id = 'stripe-js'; s.src = 'https://js.stripe.com/v3/'; s.onload = mount
      document.head.appendChild(s)
    } else {
      // Script present but Stripe still loading — onload won't fire again.
      poll = setInterval(() => { if (window.Stripe) { clearInterval(poll); mount() } }, 50)
      setTimeout(() => poll && clearInterval(poll), 3000)
    }
    return () => {
      if (poll) clearInterval(poll)
      for (const r of [numberElRef, expiryElRef, cvcElRef]) {
        if (r.current) { r.current.destroy(); r.current = null }
      }
    }
  }, [paymentActive, stripeKey, savedCard, useNewCard, cardResetKey])

  // ── Computed ───────────────────────────────────────────────────────────────
  const fm = useMemo(() => extractFmMoney(fmTotals), [fmTotals])
  const displayDeliveryFee = fm?.deliveryFee ?? null
  // Tax exempt → show $0 for the sales-tax portion. FM is NOT told about the
  // exemption (we strip taxExempt from the update so it doesn't 500), so it still
  // returns tax — we zero it here and remove it from the total (fmTotalEffective).
  const displayTax = taxExemptApplied ? 0 : (fm?.tax ?? null)
  const displayTips = fm?.tips ?? tipAmt
  const displaySvc = fm?.serviceCharge ?? svcAmt        // per-menu service charge
  const displayFee = fm?.fee ?? null                    // platform (~3%) fee
  // Combined "Taxes & Fees" line (platform fee + sales tax), mirroring FM's
  // checkout-sidebar getTaxesAndFees() = fee + state + local + other.
  const taxesAndFees = (displayFee !== null || displayTax !== null)
    ? (displayFee ?? 0) + (displayTax ?? 0)
    : null
  // When tax-exempt, FM still returns the sales tax inside its `total` (we strip
  // the taxExempt flag from the FM update so FM never zeroes it server-side), so
  // subtract the FM-reported tax client-side to reflect the exemption in the total.
  const fmTotalEffective = fm?.total != null
    ? (taxExemptApplied ? Math.max(0, Math.round((fm.total - (fm.tax ?? 0)) * 100) / 100) : fm.total)
    : null
  // Best-known order total for analytics — mirrors PaymentStep's payTotal
  // (FM's canonical total, else the client estimate). Kept in a ref so the
  // Stripe focus handler reads the freshest value.
  const trackingTotal = fmTotalEffective ?? (
    subtotal + (displayTips || 0) + (displaySvc || 0)
      + (taxesAndFees ?? 0) + (displayDeliveryFee ?? 0)
      - (fm?.discount ?? 0)
  )
  totalRef.current = trackingTotal

  const taxIdValid = /^\d{6,12}$/.test(taxExemptId)
  const canApplyExempt = taxIdValid && !!taxExemptState
  const canProceed = cart.length > 0 && !!selDate && !!selTime && (orderType === 'PICKUP' || (!!addr.line1 && !!addr.city && !!addr.state && !!addr.zip && addr.lat != null && addr.lng != null))
  const fmAddr: FmDeliveryAddr = {
    addressLine1: addr.line1,
    addressLine2: addr.line2 || '',
    city: addr.city,
    state: addr.state,
    zipcode: addr.zip,
    latitude: addr.lat ?? undefined,
    longitude: addr.lng ?? undefined,
    deliveryInstructions: deliveryNotes || '',
  }

  // ── Pricing preview (Item 1) ─────────────────────────────────────────────────
  // FM has no client-side tax/fee math and no public tax-rate endpoint — it
  // inits a draft order and PUTs to get server-computed fee + tax (the same
  // checkoutPricesV2 preview FM's own checkout uses). We mirror that here so the
  // Order Summary shows real numbers before payment. Best-effort: on failure the
  // summary falls back to "Calculated at checkout" (never a guessed amount).
  const previewSeq = useRef(0)
  const orderRefRef = useRef('')
  useEffect(() => { orderRefRef.current = orderRef }, [orderRef])

  // Stable string fingerprint of the cart, used as a dependency for the
  // re-price effect below — cart changes (qty +/- or add-on edits upstream)
  // mean the PUT must re-fire so FM recomputes tax/fees/total.
  const cartKey = useMemo(
    () => cart.map(i => `${i.pkg.reference}:${i.quantity}:${i.addOns.map(a => `${a.reference}x${a.count}`).join(',')}`).join('|'),
    [cart],
  )

  // The full ICheckoutPreview DTO that FM's init, re-price (PUT), and place all
  // take. Built from one place so the priced order and the placed order can't
  // drift apart.
  function buildCheckoutDto(opts?: { couponCode?: string | null }) {
    // FM coupon code: explicit override (used by apply/clear to validate before
    // committing state), else the currently-applied FM promo. Disco promos are
    // NEVER sent to FM (display-only).
    const couponCode = opts && 'couponCode' in opts
      ? opts.couponCode
      : (appliedPromo?.type === 'fm' ? appliedPromo.code : null)
    const base = buildCheckoutPayload({
      restaurantRef: fmRef,
      cart: cart.map(i => ({ reference: i.pkg.reference, name: i.pkg.name, price: i.pkg.price, count: i.quantity, addOns: i.addOns, note: i.note })),
      // FM requires orderType as "PICKUP" or "DELIVERY" — empty string causes 500
      orderType: (orderType || 'PICKUP') as 'DELIVERY' | 'PICKUP',
      orderDate: selDate, orderTime: selTime,
      deliveryAddress: orderType === 'DELIVERY' ? fmAddr : undefined,
      headcount,
    })
    return {
      ...base,
      tips: tipAmt,
      // FM's TipsType enum is CUSTOM | PERCENTAGE only ("DOLLAR" 500'd the init/
      // PUT). The drawer computes a dollar tip, which is FM's CUSTOM (a fixed $
      // amount, like the per-menu tipOption customTipSize); no tip → PERCENTAGE 0.
      tipsType: tipAmt > 0 ? 'CUSTOM' : 'PERCENTAGE',
      // Tax exemption is NOT sent to FM (it must keep the tax in its total/PI so
      // the place route can subtract it from the Stripe PaymentIntent). taxExemptId
      // is still passed so the Neon mirror can persist it on disco_orders.
      ...(taxExemptApplied && taxExemptId ? { taxExemptId } : {}),
      ...(couponCode ? { couponCode } : {}),
    }
  }

  async function runPricing(advance: boolean): Promise<string | null> {
    const seq = ++previewSeq.current
    // Mirrors FM's checkoutPricesV2 (meal-package.service.ts:311-355): an if/else
    // that POSTs /orders/init the first time (no ref yet), then PUTs /orders/{ref}
    // to re-price on later changes — exactly ONE request per pricing event. FM
    // never fires init and the PUT back-to-back (re-pricing an order it just
    // created is what 500'd).
    const dto = buildCheckoutDto()

    let ref = orderRefRef.current
    if (!ref) {
      const initRes = await fetch('/api/order/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dto) })
      const initData = await initRes.json()
      if (!initRes.ok) throw new Error(initData.error || initData.message || 'Failed to create order draft.')
      // FM init returns { success, data: { orderReference, checkoutPublicResponseDto } }.
      ref = initData.data?.orderReference || initData.orderReference || initData.reference || initData.orderRef || initData.id || ''
      if (!ref) throw new Error('Order created but no reference returned.')
      orderRefRef.current = ref
      setOrderRef(ref)
      if (initData.data?.checkoutPublicResponseDto || initData.data) setFmTotals(initData)
      if (orderType === 'DELIVERY') {
        fetch('/api/order/validate-address', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurantReference: fmRef, deliveryAddress: fmAddr, menuReference }) }).catch(() => {})
      }
      // NOTE: FM's /orders/slotselected (slot reservation) is intentionally not
      // called — init already creates the draft order, and the call 400'd from a
      // payload mismatch (FM wants orderDate DD.MM.YYYY + restaurantReference +
      // menuReference, activity-tracker.service.ts:127-133). Re-add with that
      // exact shape only if slot-hold-on-reserve becomes necessary.
      // init already returned the full pricing (set above); do NOT PUT on the
      // first run — re-pricing an order FM just created is what 500'd.
      return ref
    }
    // Re-price an EXISTING order (ref existed on entry) with the FULL DTO + the
    // ref (proxy strips restaurantRef/orderRef for the URL, forwards the rest).
    const updRes = await fetch('/api/order/update', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...dto, restaurantRef: fmRef, orderRef: ref }),
    })
    const updData = await updRes.json()
    if (updRes.ok && !updData.error && (advance || seq === previewSeq.current)) setFmTotals(updData)
    return ref
  }

  // Stage 2 is the ONLY drawer view (the old in-drawer "review" step is gone —
  // Stage 1 is the cart on the restaurant page). On mount, draft the order
  // (init + price) and put us on the payment step. Logged-out users get the
  // auth modal via processOrder's existing branch; waitingForAuth resumes the
  // flow on login. The drawer trigger upstream already gates on canProceed, so
  // this should always run on mount.
  const startedRef = useRef(false)
  useEffect(() => {
    if (startedRef.current) return
    if (!canProceed) return
    startedRef.current = true
    processOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProceed])

  // Re-price on the payment step when tax-exempt or the promo code changes (FM
  // applies both server-side; the update PUT carries them).
  useEffect(() => {
    if (step !== 'payment' || !orderRef) return
    runPricing(true).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxExemptApplied])

  // Re-price when the upstream tip selection or cart contents change. tipAmt,
  // cart subtotal, and cart contents come in as props (the tip pills and qty
  // +/- buttons live in RestaurantClient's cart panel), and FM has to recompute
  // tax/fees/total whenever any of them shift. Skips on first mount because
  // step is still 'processing' until init returns. Once on 'payment' with a
  // ref, every later change in deps fires a PUT.
  useEffect(() => {
    if (step !== 'payment' || !orderRef) return
    runPricing(true).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipAmt, cartKey])

  // First-time customer? (0 prior FM orders) — gates first_time_only promo codes.
  // Customer flow only; direct entry never applies a customer promo.
  useEffect(() => {
    if (isDirectEntry || !authUser) return
    fetch('/api/fm-order-history?page=0&size=1', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        const total = typeof d.totalElements === 'number'
          ? d.totalElements
          : (Array.isArray(d.content) ? d.content.length : (Array.isArray(d) ? d.length : 0))
        setIsFirstTimeUser(total === 0)
      })
      .catch(() => {})
  }, [authUser, isDirectEntry])

  // ── Handlers ───────────────────────────────────────────────────────────────

  // Unified Apply: try the code as a Disco promo first. On 404, fall back to an
  // FM coupon — re-price the draft with couponCode and accept it only if FM
  // returns a discount; otherwise it's invalid.
  async function applyPromo() {
    const code = promoInput.trim().toUpperCase()
    if (!code) return
    setPromoLoading(true); setPromoError('')
    try {
      // 1) Disco first.
      const res = await fetch('/api/promo/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          restaurantRef: fmRef,
          orderSubtotal: fm?.subtotal ?? subtotal,
          orderTotal: trackingTotal,
          userEmail: contactEmail || authUser?.email || '',
          isFirstTimeUser,
        }),
      })

      if (res.status === 404) {
        // 2) Not a Disco code → try as an FM coupon. PUT the draft with couponCode
        // and confirm FM applied a discount.
        const ref = orderRefRef.current
        if (!ref) { setPromoError('Please wait a moment and try again.'); return }
        const dto = { ...buildCheckoutDto({ couponCode: code }), restaurantRef: fmRef, orderRef: ref }
        const updRes = await fetch('/api/order/update', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dto),
        })
        const updData = await updRes.json().catch(() => ({}))
        const money = extractFmMoney(updData)
        if (updRes.ok && !updData.error && money && money.discount > 0) {
          setFmTotals(updData)
          setAppliedPromo({ type: 'fm', code })
          setPromoError('')
        } else {
          setPromoError('Invalid promo code.')
        }
        return
      }

      // Disco result.
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.valid) {
        setAppliedPromo({ type: 'disco', code: d.code || code, discountAmount: d.discountAmount })
        setPromoError('')
      } else {
        setAppliedPromo(null)
        setPromoError(d.message || 'Invalid promo code.')
      }
    } catch {
      setPromoError('Could not validate the code. Please try again.')
    } finally {
      setPromoLoading(false)
    }
  }

  // Clear the applied promo. For an FM coupon, re-price the draft WITHOUT the
  // couponCode so the displayed total reverts.
  function clearPromo() {
    const wasFm = appliedPromo?.type === 'fm'
    setAppliedPromo(null); setPromoError(''); setPromoInput('')
    if (wasFm) {
      const ref = orderRefRef.current
      if (ref) {
        const dto = { ...buildCheckoutDto({ couponCode: null }), restaurantRef: fmRef, orderRef: ref }
        fetch('/api/order/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dto) })
          .then(r => r.json()).then(d => { if (d && !d.error) setFmTotals(d) }).catch(() => {})
      }
    }
  }

  async function processOrder() {
    setStep('processing'); setError('')
    // Pass a (no-op) pendingAction so AuthModal does NOT redirect a diner to
    // /account/orders after login — the waitingForAuth effect resumes checkout
    // here instead, keeping them in the cart/checkout flow (Item 5).
    // Direct entry skips this entirely: the restaurant admin is authenticated
    // via the restaurant cookie, not the customer AuthContext.
    if (!isDirectEntry && !authUser) { setWaitingForAuth(true); openAuthModal(() => {}, 'login'); return }

    try {
      // Reuses the draft from the review-step preview if one exists (no
      // duplicate init), then PUTs for canonical totals incl. tax-exempt.
      await runPricing(true)
      setStep('payment')
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.')
      setStep('payment')
    }
  }

  // GA funnel: payment failed (card declined, tokenization error, or a
  // confirm-payment that didn't reach 'succeeded'). Excludes Direct Entry.
  function trackPaymentFailed(errorType: string) {
    if (isDirectEntry) return
    trackEvent('checkout_payment_failed', { restaurant_name: restaurantName, total: trackingTotal, error_type: errorType })
  }

  async function handlePlaceOrder() {
    // Customer payment path still requires a logged-in diner; direct entry does
    // not (admin auth is the restaurant cookie).
    if (!isDirectEntry && !authUser) return
    setError('')

    const isInvoice = isDirectEntry && directEntryMethod === 'invoice'

    // GA funnel: Place Order clicked, before any API call. Excludes Direct Entry.
    if (!isDirectEntry) {
      const usingSavedCard = savedCard && !useNewCard
      trackEvent('checkout_payment_attempted', {
        restaurant_name: restaurantName,
        total: trackingTotal,
        order_type: orderType,
        payment_method: isInvoice ? 'invoice' : (usingSavedCard ? 'saved_card' : 'card'),
      })
    }
    // Direct-entry payment RETRY after a declined card: FM
    // (confirmOrderPaymentByPayStatement, checkout-sidebar-preview.component.ts:
    // 1342) reuses the SAME orderRef + paymentIntentId and just re-confirms with
    // a NEW paymentMethodId — it never re-places (the isOrderAlreadyCreated flag
    // guards that). Re-placing mints a second PaymentIntent for the same order →
    // FM 409. So on a retry we skip the place call and confirm the stored PI.
    const retry = (isDirectEntry && !isInvoice) ? directEntryRetry.current : null

    try {
      // FM's payment flow (checkout-customer-info.component.ts:762-816 +
      // checkout-sidebar-preview.component.ts:1205-1252): tokenize → create a
      // PaymentMethod → place the order (FM mints the Stripe PaymentIntent here)
      // → confirm that PaymentIntent server-side with paymentIntentId +
      // paymentMethodId → require paymentIntentStatus 'succeeded'. The card is
      // charged in the confirm step; placing the order alone does NOT charge it.
      const usingSavedCard = savedCard && !useNewCard
      let paymentMethodId: string | null = null
      if (!isInvoice && !usingSavedCard) {
        if (!stripeRef.current || !numberElRef.current) {
          setError('Payment form not ready. Please wait and try again.')
          setStep('payment'); return
        }
        // Tokenize the card (must run before any setStep — changing step re-runs
        // the mount effect and would tear down the Element mid-tokenization),
        // then turn the token into a PaymentMethod, exactly as FM does.
        const tok = await stripeRef.current.createToken(numberElRef.current)
        if (tok.error) { trackPaymentFailed('card_token_error'); setError(tok.error.message || 'Card error.'); setStep('payment'); return }
        const pm = await stripeRef.current.createPaymentMethod({ type: 'card', card: { token: tok.token.id } })
        if (pm.error) { trackPaymentFailed('card_method_error'); setError(pm.error.message || 'Card error.'); setStep('payment'); return }
        paymentMethodId = pm.paymentMethod?.id ?? null
      }

      // Card ready (or using a saved card) — now show the placing state.
      setStep('placing')

      // Resolve the order + PaymentIntent we'll confirm. On a retry we reuse the
      // ones from the prior (failed) attempt; otherwise we place the order now.
      let finalRef: string
      let paymentIntentId: string | undefined
      let placedOrderNumber: number | string | undefined // for checkout_completed

      if (retry) {
        finalRef = retry.orderReference
        paymentIntentId = retry.paymentIntentId
      } else {
        // Place the order — FM expects the full order object (checkout-sidebar-
        // preview.component.ts:1169-1176 + 1300-1309): the priced DTO under
        // checkoutDetails (+ paymentMethod, sourceoforder), the customer, and
        // deliveryAddress for DELIVERY only (FM deletes it for PICKUP, :1178).
        const checkoutDetails: Record<string, unknown> = {
          ...buildCheckoutDto(),
          // INVOICE for direct-entry invoice flow (FM creates an unpaid order +
          // emails a payment link); PAYMENT otherwise.
          paymentMethod: isInvoice ? 'INVOICE' : 'PAYMENT',
          // FM attributes lead-generation fees off this wire value. "DISCO" for
          // /restaurants/[slug] (3P, lead gen fee), "FAMILYMEAL" for /order/[slug]
          // (1P) AND for direct entry (restaurant placing for its own customer →
          // no lead-gen fee). Never expose these strings in the UI (show 3P/1P).
          sourceoforder: (isFirstParty || isDirectEntry) ? 'FAMILYMEAL' : 'DISCO',
        }
        delete checkoutDetails.restaurantRef // proxy-URL field only; not part of ICheckoutPreview
        // Direct entry places with the restaurant token (admin acting for the
        // customer); the customer flow uses the diner token.
        const placeRes = await fetch(isDirectEntry ? '/api/restaurant/orders/place' : '/api/order/place', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            restaurantRef: fmRef,
            orderRef,
            checkoutDetails,
            // FM requires a digits-only phone ("Phone number has wrong format"
            // otherwise) — "732-239-7055" → "7322397055".
            customer: { firstName: contactFirst, lastName: contactLast, email: contactEmail, phoneNumber: sanitizePhone(contactPhone) },
            // FM has no order-level headcount field, so send it alongside (not in
            // the FM DTO) for the Neon mirror to persist on disco_orders.persons.
            ...(headcount != null ? { headcount } : {}),
            // Disco-only company name for the Neon mirror (stripped before FM).
            ...(contactCompany.trim() ? { companyName: contactCompany.trim() } : {}),
            // Tax exempt (customer flow only): tells /api/order/place to reduce the
            // FM PaymentIntent by the tax before confirm. taxAmount is FM's reported
            // sales tax (state+local+other) — the exact amount baked into the PI.
            ...(taxExemptApplied && !isDirectEntry ? { taxExemptApplied: true, taxAmount: fm?.tax ?? 0, taxExemptState } : {}),
            ...(orderType === 'DELIVERY' ? { deliveryAddress: fmAddr } : {}),
          }),
        })
        const placeData = await placeRes.json()
        if (!placeRes.ok && placeData.error) throw new Error(placeData.error || placeData.message || 'Failed to place order.')
        finalRef = placeData.data?.orderReference || placeData.reference || placeData.orderReference || orderRef
        placedOrderNumber = placeData.data?.orderNumber ?? placeData.orderNumber ?? finalRef

        // Invoice (direct entry): the order is created unpaid and FM emails the
        // customer a payment link. No card, no confirm-payment — done.
        if (isInvoice) { setStep('sent'); return }

        const paymentDetails = placeData.data?.paymentDetails ?? placeData.paymentDetails
        paymentIntentId = paymentDetails?.stripePaymentIntentDto?.paymentIntentId
      }

      // Silent-path-A guard: the order was placed but FM returned NO PaymentIntent,
      // so the card can never be charged. Fail loudly and stay on checkout — never
      // show a confirmation for an unpaid order. (Invoice flow has no PI by design.)
      if (!isInvoice && !paymentIntentId) {
        trackPaymentFailed('no_payment_intent')
        setError('Payment could not be processed. Please try again.')
        setStep('payment'); return
      }

      // Confirm the PaymentIntent FM created during placement — THIS charges the
      // card (checkout-sidebar-preview.component.ts:1205-1252). FM's contract
      // (order.service.ts:55-70): { orderReference, restaurantReference,
      // paymentIntentId, confirmWithDefaultSource, paymentMethodId } — the
      // paymentMethodId is dropped server-side when confirmWithDefaultSource.
      if (paymentIntentId) {
        // Direct entry confirms via the restaurant-authed proxy (admin token),
        // never confirmWithDefaultSource (no saved diner card). The customer
        // flow is unchanged.
        const confirmUrl = isDirectEntry ? '/api/restaurant/orders/confirm-payment' : '/api/order/confirm-payment'
        // Fallback snapshot for the customer flow: if the async Neon mirror hasn't
        // landed by the time confirm-payment dispatches, the server writes the row
        // from this so confirmations + Expedite still fire.
        const placedOrder = isDirectEntry ? undefined : {
          orderNumber: placedOrderNumber,
          restaurantRef: fmRef,
          sourceOfOrder: isFirstParty ? 'FAMILYMEAL' : 'DISCO',
          orderType,
          orderDate: selDate,
          orderTime: selTime,
          email: contactEmail,
          firstName: contactFirst,
          lastName: contactLast,
          phone: sanitizePhone(contactPhone),
          companyName: contactCompany.trim() || undefined,
          total: trackingTotal,
          deliveryAddress: orderType === 'DELIVERY'
            ? { addressLine1: fmAddr.addressLine1, addressLine2: fmAddr.addressLine2, city: fmAddr.city, state: fmAddr.state, zip: fmAddr.zipcode, latitude: fmAddr.latitude, longitude: fmAddr.longitude }
            : null,
          items: cart.map(i => ({ reference: i.pkg.reference, name: i.pkg.name, count: i.quantity, price: i.unitPrice })),
        }
        const confirmBody = isDirectEntry
          ? { orderReference: finalRef, restaurantReference: fmRef, paymentIntentId, paymentMethodId, confirmWithDefaultSource: false }
          : { orderReference: finalRef, restaurantReference: fmRef, paymentIntentId, confirmWithDefaultSource: usingSavedCard, placedOrder, ...(usingSavedCard ? {} : { paymentMethodId }) }
        const confRes = await fetch(confirmUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(confirmBody),
        })
        const confData = await confRes.json()
        const payStatus = (confData.data?.stripePaymentIntentDto ?? confData.stripePaymentIntentDto)?.paymentIntentStatus
        // The card is only charged when FM reports 'succeeded'. Silent-path-B:
        // a missing/empty/any-other status (EVEN with HTTP 200) means NOT charged
        // — treat it as failure and never redirect to the confirmation screen.
        const charged = !!payStatus && String(payStatus).toLowerCase() === 'succeeded'
        if (!confRes.ok || !charged) {
          // Direct-entry payment failure: keep the order + PaymentIntent so the
          // NEXT attempt re-confirms the SAME PI with a new card (FM's retry —
          // no re-place, avoids the 409), and remount the card fields so a fresh
          // number can be entered without closing the drawer.
          if (isDirectEntry && !isInvoice && paymentIntentId) {
            directEntryRetry.current = { orderReference: finalRef, paymentIntentId }
            setCardResetKey(k => k + 1)
          }
          trackPaymentFailed(payStatus ? `confirm_${String(payStatus).toLowerCase()}` : 'confirm_failed')
          setError(confData.error || confData.message || 'Payment could not be completed. Please try again.')
          setStep('payment'); return
        }
        // Confirmed — clear any retry context.
        directEntryRetry.current = null
      }

      // Disco-side promo redemption — the charge succeeded, so issue the discount
      // as a Stripe refund now. Best-effort: never blocks the confirmation (the
      // order is already placed + paid; refund failures are recorded server-side).
      if (!isDirectEntry && appliedPromo?.type === 'disco' && paymentIntentId) {
        try {
          await fetch('/api/promo/redeem', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: appliedPromo.code,
              orderRef: finalRef,
              userEmail: contactEmail || authUser?.email || '',
              discountAmount: appliedPromo.discountAmount,
              stripePaymentIntentId: paymentIntentId,
            }),
          })
        } catch { /* order is placed; refund failure handled server-side / by ops */ }
      }

      // Save address silently (post-order) — customer flow only; direct entry
      // has no diner account to attach it to.
      if (!isDirectEntry && orderType === 'DELIVERY' && addr.line1) {
        fetch('/api/fm-user-addresses', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr.line1, city: addr.city, state: addr.state, zipCode: addr.zip }),
        }).catch(() => {})
      }

      // GA funnel: order completed. Customer flow only (Direct Entry excluded).
      // Fires after payment confirmed 'succeeded' (or, for non-card flows, a
      // successful place), just before the confirmation redirect.
      if (!isDirectEntry) {
        trackEvent('checkout_completed', {
          restaurant_name: restaurantName,
          order_number: placedOrderNumber ?? finalRef,
          total: trackingTotal,
          order_type: orderType,
          source: isFirstParty ? 'FAMILYMEAL' : 'DISCO',
        })
      }

      // Direct entry returns to the portal Orders list; the customer flow goes
      // to the public order-confirmation page.
      router.push(isDirectEntry ? '/restaurant/orders' : `/order-confirmation/${finalRef}`)
    } catch (err: any) {
      trackPaymentFailed('exception')
      setError(err.message || 'Something went wrong. Please try again.')
      // If we'd already entered the placing step, the card fields were detached;
      // remount them (direct entry) so the admin can retry without reopening.
      if (isDirectEntry && !isInvoice) setCardResetKey(k => k + 1)
      setStep('payment')
    }
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
    // Direct-entry invoice hides all card UI; card-payment uses the normal
    // card fields + Place Order button (now live via the restaurant proxy).
    const hideCard = isDirectEntry && directEntryMethod === 'invoice'
    // Read totals from the EXTRACTED `fm` (which walks
    // data.checkoutPublicResponseDto), not raw `fmTotals` — fmTotals.total is
    // nested under data.* so the direct lookup missed it and silently fell
    // through to subtotal+tip+svc, dropping tax/fees from the displayed total.
    const fmSubtotal = fm?.subtotal ?? subtotal
    // fmTotalEffective already removes FM's tax when tax-exempt (see above), so
    // the customer is charged the exemption-adjusted total.
    const payTotal = fmTotalEffective ?? (
      subtotal + (displayTips || 0) + (displaySvc || 0)
        + (taxesAndFees ?? 0) + (displayDeliveryFee ?? 0)
        - (fm?.discount ?? 0)
    )
    // Disco promo charges the full FM total, then credits it back via Stripe
    // after placement — so the displayed total is always the full payTotal, with
    // a note about the pending credit. (FM coupons are already in payTotal.)
    return (
      <>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f0' }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: 0, letterSpacing: '-0.02em' }}>Review &amp; Pay</h2>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {/* Date / time / order-type pill (lifted from the old ReviewStep so the
              drawer is a single Review & Pay surface). */}
          <div style={{ padding: '0 0 14px', borderBottom: '1px solid #f4f4f4', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {selDate && <span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtDateShort(selDate)}</span>}
              {selTime && <><span style={{ color: '#ddd' }}>·</span><span style={{ fontSize: 13, fontWeight: 700, color: DARK }}>{fmtTime(selTime)}</span></>}
              <span style={{ color: '#ddd' }}>·</span>
              <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: orderType === 'PICKUP' ? '#EEF0FD' : '#F0FDF4', color: orderType === 'PICKUP' ? INDIGO : '#166534' }}>
                {orderType === 'PICKUP' ? '🏃 Pickup' : '🚚 Delivery'}
              </span>
            </div>
          </div>

          {/* Delivery — validated address (read-only) + editable instructions +
              Change address. Mirrors FM's checkout-customer-info delivery panel
              (addressLine1/addressLine2 + Delivery Instructions). PICKUP shows
              nothing here. */}
          {orderType === 'DELIVERY' && (
            <div style={{ padding: '0 0 14px', borderBottom: '1px solid #f4f4f4', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Delivery to</div>
                <button onClick={onChangeAddress || onClose}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: 0 }}>
                  Change address
                </button>
              </div>
              <div style={{ fontSize: 13, color: DARK, lineHeight: 1.5 }}>
                {addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}<br />
                {[addr.city, addr.state].filter(Boolean).join(', ')} {addr.zip}
              </div>
              <input
                value={deliveryNotes}
                onChange={e => setDeliveryNotes(e.target.value)}
                placeholder="Delivery instructions (optional)"
                aria-label="Delivery instructions"
                style={{ width: '100%', height: 38, marginTop: 8, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          )}

          {/* Items summary (read-only — quantities are edited in Stage 1). */}
          <div style={{ padding: '0 0 14px', borderBottom: '1px solid #f4f4f4', marginBottom: 16 }}>
            {cart.map(item => (
              <div key={item.lineId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{item.quantity > 1 && <span style={{ color: '#888' }}>{item.quantity}× </span>}{item.pkg.name}</div>
                  {item.pkg.serves && <div style={{ fontSize: 11, color: '#aaa' }}>Serves {item.pkg.serves}</div>}
                  {item.addOns.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {item.addOns.map(a => (
                        <div key={a.reference} style={{ fontSize: 11, color: '#888' }}>+ ({a.count}) {a.name}{a.price > 0 ? ` (+${fmt$(a.price)} each)` : ''}</div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: DARK, flexShrink: 0, marginLeft: 12 }}>{fmt$(item.unitPrice * item.quantity)}</div>
              </div>
            ))}
          </div>

          {/* Headcount — inline prompt if not set, otherwise a single-line summary. */}
          {headcount == null && !headcountSkipped ? (
            <div style={{ background: '#F5F4FF', border: '1px solid #E5E3FB', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: DARK, marginBottom: 8 }}>How many people are you feeding?</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="number" inputMode="numeric" min={1}
                  value={headcountInput}
                  onChange={e => setHeadcountInput(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={e => { if (e.key === 'Enter') { const n = parseInt(headcountInput, 10); if (!isNaN(n) && n > 0) onHeadcount(n) } }}
                  placeholder="e.g. 40"
                  style={{ flex: 1, height: 38, border: '1.5px solid #e8e8e8', borderRadius: 8, padding: '0 10px', fontSize: 13, color: DARK, fontFamily: F, background: '#fff', outline: 'none' }} />
                <button onClick={() => { const n = parseInt(headcountInput, 10); if (!isNaN(n) && n > 0) onHeadcount(n) }}
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
          ) : headcount != null ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 14px', borderBottom: '1px solid #f4f4f4', marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#555' }}>👥 {headcount} {headcount === 1 ? 'person' : 'people'}</div>
              <button onClick={() => { setHeadcountInput(String(headcount)); onHeadcount(null) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: BLUE, fontWeight: 700, fontFamily: F, padding: '2px 6px' }}>
                Edit
              </button>
            </div>
          ) : null}

          {/* Contact fields — pre-filled from authUser, editable per the spec.
              These values feed the place body's `customer` object, mirroring FM
              (checkout-customer-info.component.ts:195-204, 313-318). */}
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Contact</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <input value={contactFirst} onChange={e => setContactFirst(e.target.value)} placeholder="First name" aria-label="First name"
                style={{ height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
              <input value={contactLast} onChange={e => setContactLast(e.target.value)} placeholder="Last name" aria-label="Last name"
                style={{ height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
            </div>
            <input value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="Email" type="email" inputMode="email" aria-label="Email"
              style={{ width: '100%', height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', marginBottom: 10, boxSizing: 'border-box' }} />
            {/* contactPhone holds digits only; the field shows them formatted and
                auto-strips any non-digit the user types/pastes. FM gets digits. */}
            <input value={formatPhoneDisplay(contactPhone)} onChange={e => setContactPhone(sanitizePhone(e.target.value))} placeholder="Phone" type="tel" inputMode="tel" aria-label="Phone" maxLength={16}
              style={{ width: '100%', height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }} />
            {/* Optional company name — subtle, below phone. Disco-only. */}
            <input value={contactCompany} onChange={e => setContactCompany(e.target.value)} placeholder="Company name (optional)" aria-label="Company name"
              style={{ width: '100%', height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box', marginTop: 10 }} />
          </div>

          {/* Totals from FM (or client-side estimate) */}
          <div style={{ background: '#fafafa', borderRadius: 12, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
              <span>Subtotal</span><span>{fmt$(fmSubtotal)}</span>
            </div>
            {orderType === 'DELIVERY' && displayDeliveryFee !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span>Delivery Fee</span>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
              <span>Tip</span><span>{fmt$(displayTips || 0)}</span>
            </div>
            {taxesAndFees !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#666', marginBottom: 5 }}>
                <span title={`Includes applicable sales tax and a small service fee.${taxExemptApplied ? ' (tax exempt)' : ''}`}>Taxes &amp; Fees</span>
                <span>{fmt$(taxesAndFees)}</span>
              </div>
            )}
            {taxExemptApplied && (
              <div style={{ fontSize: 11, color: '#22C55E', textAlign: 'right', marginBottom: 5 }}>Tax exempt applied</div>
            )}
            {fm && fm.discount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#1D9E75', marginBottom: 5 }}>
                <span>Discount{appliedPromo?.type === 'fm' ? ` (${appliedPromo.code})` : ''}</span><span>−{fmt$(fm.discount)}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1.5px solid #ebebeb', paddingTop: 10, marginTop: 6, fontSize: 17, fontWeight: 800, color: DARK }}>
              <span>Total</span><span>{fmt$(payTotal)}</span>
            </div>
            {/* Disco promo is charged in full, then credited back via Stripe after
                the order — so the displayed total stays the full FM amount. */}
            {appliedPromo?.type === 'disco' && (
              <div style={{ fontSize: 11, color: '#999', marginTop: 6, lineHeight: 1.45 }}>
                Promo code {appliedPromo.code} will apply a {fmt$(appliedPromo.discountAmount)} credit to your card after your order is placed
              </div>
            )}
            {!fmTotals && <div style={{ fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 2 }}>Estimate — final total confirmed at payment</div>}
          </div>

          {/* Single promo entry — Disco codes first, FM coupon fallback. */}
          <div style={{ marginBottom: 16 }}>
            {appliedPromo ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 10, padding: '10px 14px' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#047857' }}>
                  {appliedPromo.type === 'disco'
                    ? `Promo “${appliedPromo.code}” applied — −${fmt$(appliedPromo.discountAmount)}`
                    : `Promo “${appliedPromo.code}” applied`}
                </span>
                <button onClick={clearPromo} aria-label="Remove promo code"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#047857', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ) : !promoOpen ? (
              <button onClick={() => setPromoOpen(true)}
                style={{ background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: 0 }}>
                Have a promo code?
              </button>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={promoInput} onChange={e => setPromoInput(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === 'Enter') applyPromo() }}
                    placeholder="Enter code" aria-label="Promo code"
                    style={{ flex: 1, height: 40, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 12px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none', textTransform: 'uppercase' }} />
                  <button onClick={applyPromo} disabled={!promoInput.trim() || promoLoading}
                    style={{ height: 40, padding: '0 18px', background: promoInput.trim() && !promoLoading ? BLUE : '#e8e8e8', color: promoInput.trim() && !promoLoading ? '#fff' : '#bbb', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: promoInput.trim() && !promoLoading ? 'pointer' : 'default', fontFamily: F }}>
                    {promoLoading ? 'Checking…' : 'Apply'}
                  </button>
                </div>
                {promoError && <div style={{ color: '#E24B4A', fontSize: 12, marginTop: 6 }}>{promoError}</div>}
              </>
            )}
          </div>

          {/* Tax Exempt Account (Item 4). On Apply the order re-prices with
              taxExempt=true and FM zeroes tax server-side. ID is any 6-12 digits
              with no external check (FM uses a 9-digit SSN/ITIN validator —
              relaxed per product decision; see proxy TODO). */}
          {/* Collapsed by default: a link that expands to the fields, mirroring
              FM's "My order is tax exempt" → expand pattern
              (checkout-customer-info.component.html:146-170). */}
          {taxExemptApplied ? (
            <div style={{ background: '#fafafa', borderRadius: 12, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1D9E75' }}>Tax Exempt Applied ✓</span>
              <button onClick={() => { setTaxExemptApplied(false) }}
                style={{ background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: 0 }}>
                Remove
              </button>
            </div>
          ) : taxExemptOpen ? (
            <div style={{ background: '#fafafa', borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 8 }}>Tax Exempt Account</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={taxExemptId} onChange={e => setTaxExemptId(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric" placeholder="Tax exempt ID (6–12 digits)"
                  style={{ flex: '1 1 160px', minWidth: 0, height: 38, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 10px', fontSize: 13, fontFamily: F, color: DARK, outline: 'none' }} />
                <select value={taxExemptState} onChange={e => setTaxExemptState(e.target.value)}
                  style={{ flex: '0 0 92px', height: 38, border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '0 8px', fontSize: 13, fontFamily: F, color: taxExemptState ? DARK : '#999', outline: 'none', background: '#fff' }}>
                  <option value="">State</option>
                  {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => { if (canApplyExempt) setTaxExemptApplied(true) }} disabled={!canApplyExempt}
                  style={{ height: 38, padding: '0 16px', background: canApplyExempt ? BLUE : '#e8e8e8', color: canApplyExempt ? '#fff' : '#bbb', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: canApplyExempt ? 'pointer' : 'default', fontFamily: F }}>
                  Apply
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 8 }}>Tax exempt ID and state are both required.</div>
            </div>
          ) : (
            <button onClick={() => setTaxExemptOpen(true)}
              style={{ background: 'none', border: 'none', color: BLUE, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F, padding: '0 0 16px', display: 'block' }}>
              My order is tax exempt
            </button>
          )}

          {/* Payment method — saved card is offered as a selectable option
              alongside "Use a different card". When no saved card exists, the
              card-entry fields render directly. */}
          {!hideCard && (() => {
            const cardFields = stripeKey ? (
              <>
                <label style={fieldLabel}>Card number</label>
                <div ref={numberRef} style={fieldBox} />
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>Expiry</label>
                    <div ref={expiryRef} style={fieldBox} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabel}>CVC</label>
                    <div ref={cvcRef} style={fieldBox} />
                  </div>
                </div>
              </>
            ) : <div style={{ fontSize: 13, color: '#aaa', padding: '8px 0' }}>Loading secure payment form…</div>

            if (!savedCard) {
              return (
                <div style={{ background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Payment Method</div>
                  {cardFields}
                </div>
              )
            }

            const optionRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', padding: '12px 0' }
            return (
              <div style={{ background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 12, padding: '4px 18px 14px', marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 0' }}>Payment Method</div>

                {/* Option 1 — saved card (default) */}
                <label style={optionRow}>
                  <input type="radio" name="disco-pay-method" checked={!useNewCard} onChange={() => setUseNewCard(false)} style={{ accentColor: BLUE, width: 16, height: 16, flexShrink: 0 }} />
                  {/* Generic card icon only — never a network/Stripe Link brand mark. */}
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                  <div>
                    {/* Render last4 plainly — no card brand label, so a "link"
                        brand (Stripe Link) doesn't show a Link bubble. */}
                    <div style={{ fontSize: 14, fontWeight: 700, color: DARK, letterSpacing: '0.04em' }}>•••• {savedCard.last4 || savedCard.lastFour || '••••'} — Use saved card</div>
                    {(savedCard.expMonth || savedCard.exp_month) && (
                      <div style={{ fontSize: 12, color: '#888' }}>Expires {savedCard.expMonth || savedCard.exp_month}/{String(savedCard.expYear || savedCard.exp_year || '').slice(-2)}</div>
                    )}
                  </div>
                </label>

                {/* Option 2 — different card */}
                <label style={{ ...optionRow, borderTop: '1px solid #f5f5f5' }}>
                  <input type="radio" name="disco-pay-method" checked={useNewCard} onChange={() => setUseNewCard(true)} style={{ accentColor: BLUE, width: 16, height: 16, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: DARK }}>Use a different card</span>
                </label>

                {useNewCard && <div style={{ marginTop: 4 }}>{cardFields}</div>}
              </div>
            )
          })()}

        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f0' }}>
          {error && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, padding: '10px 12px', marginBottom: 12, color: '#991B1B', fontSize: 13 }}>{error}</div>
          )}
          <button onClick={handlePlaceOrder}
            style={{ width: '100%', padding: '14px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: F, boxShadow: '0 4px 14px rgba(91,111,232,0.25)', transition: 'all 0.15s' }}>
            {hideCard ? 'Send Invoice' : `Place Order · ${fmt$(payTotal)}`}
          </button>
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

  // ── Step: Invoice sent (direct entry) ───────────────────────────────────────
  function SentStep() {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 52, marginBottom: 14 }}>✉️</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: DARK, marginBottom: 8 }}>Invoice sent</div>
        <div style={{ fontSize: 13.5, color: '#888', maxWidth: 320, marginBottom: 24 }}>The customer will receive a payment link by email to complete this order.</div>
        <button onClick={() => router.push('/restaurant/orders')}
          style={{ padding: '12px 24px', background: BLUE, color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: F }}>
          Back to Orders
        </button>
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

        {/* Step content. Call the step renderers as functions, NOT <PaymentStep />.
            As JSX elements they'd be a fresh component type on each parent
            re-render, so React would unmount/remount the subtree — destroying
            the card <div> and detaching the mounted Stripe Element ("could not
            retrieve data"). Inlining keeps the node stable. (None of these use
            hooks, so calling them conditionally is safe.) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {step === 'processing' && ProcessingStep()}
          {step === 'payment' && PaymentStep()}
          {step === 'placing' && PlacingStep()}
          {step === 'sent' && SentStep()}
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
