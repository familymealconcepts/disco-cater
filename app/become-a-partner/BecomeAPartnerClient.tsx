'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'

// ── Brand ────────────────────────────────────────────────────────────────────
const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

// ── Shared styles ────────────────────────────────────────────────────────────
const pillInput: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 999, border: '1.5px solid #e6e6ee',
  padding: '0 20px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none',
  background: '#fff', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6, display: 'block' }
const primaryBtn: React.CSSProperties = {
  width: '100%', height: 50, borderRadius: 999, border: 'none', background: BLUE,
  color: '#fff', fontSize: 15, fontWeight: 700, fontFamily: F, cursor: 'pointer',
  transition: 'opacity 0.15s, background 0.15s',
}
const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600,
  fontFamily: F, cursor: 'pointer', textDecoration: 'underline',
}
const h1Style: React.CSSProperties = { fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const subStyle: React.CSSProperties = { fontSize: 14, color: '#585786', lineHeight: 1.6, margin: '0 0 8px' }
const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #ececf4', borderRadius: 20,
  boxShadow: '0 10px 40px rgba(26,16,40,0.06)', padding: '28px 26px',
}
const priceSectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#5B6FE8', textTransform: 'uppercase',
  letterSpacing: 0.5, padding: '12px 0 2px',
}

interface FormState {
  firstName: string; lastName: string; email: string; password: string
  phoneNumber: string; restaurantName: string
}
interface AddressState { street: string; city: string; state: string; zip: string }

// One parsed menu item returned by the AI menu-import route (high confidence).
interface MenuItem {
  name: string; description: string; price: number; serves: string; category: string
}

// sessionStorage snapshot key — holds all collected data EXCEPT the password so
// browser back/forward (and the Stripe redirect round-trip) keep their place.
const SNAP_KEY = 'partner_onboarding_v2'

// Small field helper — pill input with a label.
function Field({ label, value, onChange, type = 'text', placeholder, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; autoComplete?: string
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type={type} value={value} placeholder={placeholder} autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
        onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(91,111,232,0.12)' }}
        onBlur={e => { e.currentTarget.style.borderColor = '#e6e6ee'; e.currentTarget.style.boxShadow = 'none' }}
        style={pillInput}
      />
    </div>
  )
}

// One row in the pricing summary.
function PriceRow({ label, detail, value, who, highlight }: {
  label: string; detail?: string; value: string; who?: string; highlight?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14,
      padding: '14px 0', borderTop: '1px solid #f1f1f6',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{label}</div>
        {detail && <div style={{ fontSize: 12.5, color: '#888', lineHeight: 1.5, marginTop: 2 }}>{detail}</div>}
        {who && <div style={{ fontSize: 11, color: '#aaa', marginTop: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>Paid by {who}</div>}
      </div>
      <div style={{
        fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap', flexShrink: 0,
        ...(highlight
          ? { background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }
          : { color: BLUE }),
      }}>
        {value}
      </div>
    </div>
  )
}

// Steps: 0 account · 1 restaurant info · 2 first-party pricing (required) ·
// 3 marketplace (opt) · 4 third-party delivery (opt) · 5 Stripe (skippable) ·
// 6 menu · 7 "You're Live" (fires /complete, the ONLY account-provisioning call).
export default function BecomeAPartnerClient() {
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', email: '', password: '', phoneNumber: '', restaurantName: '',
  })
  const [addr, setAddr] = useState<AddressState>({ street: '', city: '', state: '', zip: '' })
  const [logoUrl, setLogoUrl] = useState('')
  const [logoUploading, setLogoUploading] = useState(false)

  const [agree, setAgree] = useState(false)
  const [joinedMarketplace, setJoinedMarketplace] = useState(false)
  const [deliveryEnabled, setDeliveryEnabled] = useState(false)

  const [stripeConnected, setStripeConnected] = useState(false)
  const [restaurantRef, setRestaurantRef] = useState('')

  // Menu step — AI import with graceful concierge fallback.
  const [menuTab, setMenuTab] = useState<'pdf' | 'url'>('pdf')
  const [menuFile, setMenuFile] = useState<File | null>(null)
  const [menuUrl, setMenuUrl] = useState('')
  const [menuProcessing, setMenuProcessing] = useState(false)
  const [menuResult, setMenuResult] = useState<null | { confidence: 'high' | 'low'; items: MenuItem[] }>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Final-step provisioning state.
  const [completing, setCompleting] = useState(false)
  const [completed, setCompleted] = useState(false)
  const completeFired = useRef(false)

  const set = (k: keyof FormState, v: string) => setForm(p => ({ ...p, [k]: v }))

  // ── Mount: restore the snapshot, handle the Stripe return ───────────────────
  useEffect(() => {
    let isStripeReturn = false
    let refFromQuery = ''
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('stripe') === 'success') {
        isStripeReturn = true
        refFromQuery = params.get('ref') || ''
      }
    } catch { /* ignore */ }

    try {
      const raw = sessionStorage.getItem(SNAP_KEY)
      if (raw) {
        const s = JSON.parse(raw)
        if (s.form) setForm(f => ({ ...f, ...s.form, password: '' })) // password never persisted
        if (s.addr) setAddr(a => ({ ...a, ...s.addr }))
        if (typeof s.logoUrl === 'string') setLogoUrl(s.logoUrl)
        if (typeof s.agree === 'boolean') setAgree(s.agree)
        if (typeof s.joinedMarketplace === 'boolean') setJoinedMarketplace(s.joinedMarketplace)
        if (typeof s.deliveryEnabled === 'boolean') setDeliveryEnabled(s.deliveryEnabled)
        if (typeof s.stripeConnected === 'boolean') setStripeConnected(s.stripeConnected)
        if (typeof s.restaurantRef === 'string') setRestaurantRef(s.restaurantRef)
        if (!isStripeReturn && Number.isFinite(s.step) && s.step >= 1 && s.step <= 6) setStep(s.step)
      }
    } catch { /* snapshot optional */ }

    if (isStripeReturn) {
      setStripeConnected(true)
      if (refFromQuery) {
        setRestaurantRef(refFromQuery)
        // Confirm charges_enabled server-side (sets stripe_onboarding_complete).
        fetch(`/api/become-a-partner/stripe-status?restaurantReference=${encodeURIComponent(refFromQuery)}`).catch(() => {})
      }
      setStep(5) // Stripe step
      try { window.history.replaceState({}, '', '/become-a-partner') } catch { /* ignore */ }
    }
  }, [])

  // Persist the snapshot (never the password) on any relevant change, for steps 0–6.
  useEffect(() => {
    try {
      if (step <= 6) {
        const snap = {
          step,
          form: { ...form, password: '' },
          addr, logoUrl, agree, joinedMarketplace, deliveryEnabled, stripeConnected, restaurantRef,
        }
        sessionStorage.setItem(SNAP_KEY, JSON.stringify(snap))
      }
    } catch { /* sessionStorage unavailable */ }
  }, [step, form, addr, logoUrl, agree, joinedMarketplace, deliveryEnabled, stripeConnected, restaurantRef])

  // Google Places Autocomplete on the restaurant address (step 1). Progressive
  // enhancement — manual entry still works without the script/key.
  const streetInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (step !== 1) return
    const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    if (!KEY) return
    function init() {
      const g = (window as unknown as { google?: { maps?: { places?: { Autocomplete: new (...a: unknown[]) => { addListener: (e: string, cb: () => void) => void; getPlace: () => { address_components?: { types: string[]; long_name: string; short_name: string }[] } } } } } }).google
      const Auto = g?.maps?.places?.Autocomplete
      if (!Auto || !streetInputRef.current) return
      const ac = new Auto(streetInputRef.current, { types: ['address'], componentRestrictions: { country: 'us' }, fields: ['address_components', 'formatted_address'] })
      ac.addListener('place_changed', () => {
        const comp = ac.getPlace()?.address_components || []
        const get = (t: string) => comp.find(c => c.types.includes(t))?.long_name || ''
        const getShort = (t: string) => comp.find(c => c.types.includes(t))?.short_name || ''
        setAddr({
          street: [get('street_number'), get('route')].filter(Boolean).join(' '),
          city: get('locality') || get('sublocality') || get('postal_town'),
          state: getShort('administrative_area_level_1'),
          zip: get('postal_code'),
        })
      })
    }
    const w = window as unknown as { google?: { maps?: { places?: unknown } } }
    if (w.google?.maps?.places) { init(); return }
    const existing = document.querySelector('script[data-gmaps-partner]') as HTMLScriptElement | null
    if (existing) { existing.addEventListener('load', init); return () => existing.removeEventListener('load', init) }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places`
    s.async = true; s.setAttribute('data-gmaps-partner', '1')
    s.addEventListener('load', init)
    document.head.appendChild(s)
  }, [step])

  // Fire the final account-creation call exactly once when we reach the live step.
  useEffect(() => {
    if (step === 7 && !completeFired.current) {
      completeFired.current = true
      completeOnboarding()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const step0Valid = !!form.firstName && !!form.lastName && !!form.email && form.password.length >= 8
  const step1Valid = !!form.restaurantName.trim() && !!addr.street.trim() && !!addr.city.trim() && !!addr.state.trim()

  // ── Step 4 (Stripe) → create/look-up the account by email server-side, then
  // start Connect (or skip if already connected). Snapshot is saved before the
  // redirect so the page reload keeps its place. ──
  async function connectStripe() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/become-a-partner/stripe-connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email, password: form.password,
          firstName: form.firstName, lastName: form.lastName,
          restaurantName: form.restaurantName, phone: form.phoneNumber,
          street: addr.street, city: addr.city, state: addr.state, zip: addr.zip,
        }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.alreadyConnected) {
        if (data.restaurantReference) setRestaurantRef(String(data.restaurantReference))
        setStripeConnected(true)
        setLoading(false)
        return
      }
      if (res.ok && data?.stripeConnectUrl) {
        if (data.restaurantReference) setRestaurantRef(String(data.restaurantReference))
        window.location.href = data.stripeConnectUrl // redirect; page unloads
        return
      }
      setError(data?.error || 'Could not start Stripe Connect. You can connect later from your dashboard.')
      setLoading(false)
    } catch {
      setError('Could not start Stripe Connect. You can connect later from your dashboard.')
      setLoading(false)
    }
  }

  // Upload a logo/photo to Vercel Blob (optional). Stores the returned URL.
  async function uploadLogo(file: File) {
    setLogoUploading(true)
    try {
      const fd = new FormData()
      fd.append('image', file)
      const res = await fetch('/api/become-a-partner/logo', { method: 'POST', body: fd })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.url) setLogoUrl(String(data.url))
      else setError(data?.error || 'Could not upload image.')
    } catch {
      setError('Could not upload image.')
    } finally {
      setLogoUploading(false)
    }
  }

  // Read a File into a base64 string (no data: prefix) for the JSON menu-upload.
  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || '').split(',').pop() || '')
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }

  // AI menu import — HIGH confidence previews the parsed items; anything else is a
  // graceful concierge handoff. Either way the partner continues to the live step.
  async function processMenu() {
    setError('')
    if (menuTab === 'pdf' && !menuFile) { setError('Please choose a PDF first.'); return }
    if (menuTab === 'url' && !menuUrl.trim()) { setError('Please paste a menu URL first.'); return }
    setMenuProcessing(true)
    try {
      const payload: Record<string, unknown> = {
        source: menuTab,
        restaurantName: form.restaurantName,
        restaurantEmail: form.email,
        restaurantReference: restaurantRef || '',
      }
      if (menuTab === 'pdf' && menuFile) payload.fileBase64 = await fileToBase64(menuFile)
      if (menuTab === 'url') payload.url = menuUrl.trim()

      const res = await fetch('/api/become-a-partner/menu-upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.confidence === 'high' && Array.isArray(data.items)) {
        setMenuResult({ confidence: 'high', items: data.items as MenuItem[] })
      } else {
        setMenuResult({ confidence: 'low', items: [] })
      }
    } catch (err) {
      console.error('[become-a-partner] menu processing request failed:', err)
      setMenuResult({ confidence: 'low', items: [] })
    } finally {
      setMenuProcessing(false)
    }
  }

  // Skip the menu → tell the team (best-effort), then go to the live step.
  async function skipMenu() {
    try {
      await fetch('/api/become-a-partner/menu-upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'skip',
          restaurantName: form.restaurantName,
          restaurantEmail: form.email,
          restaurantReference: restaurantRef || '',
        }),
      })
    } catch (err) {
      console.error('[become-a-partner] menu skip note failed:', err)
    }
    setStep(7)
  }

  // ── Final step → the ONLY account-provisioning call. Creates FM (best-effort),
  // the disco account + session cookie, location access, the live cache row, and
  // sends the welcome email + Slack. Retry-safe. ──
  async function completeOnboarding() {
    setError('')
    setCompleting(true)
    try {
      const res = await fetch('/api/become-a-partner/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          email: form.email, password: form.password,
          firstName: form.firstName, lastName: form.lastName,
          restaurantName: form.restaurantName, phone: form.phoneNumber,
          street: addr.street, city: addr.city, state: addr.state, zip: addr.zip,
          logoUrl, restaurantReference: restaurantRef,
          joinedMarketplace, deliveryEnabled, stripeConnected,
          menuFileName: menuTab === 'pdf' ? (menuFile?.name || '') : (menuUrl.trim() || ''),
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.success) {
        setError(data?.error || 'Something went wrong creating your account. Please try again.')
        setCompleting(false)
        return
      }
      if (data.restaurantReference) setRestaurantRef(String(data.restaurantReference))
      setCompleted(true)
      setCompleting(false)
      try { sessionStorage.removeItem(SNAP_KEY) } catch { /* ignore */ }
    } catch {
      setError('Unable to connect. Please try again.')
      setCompleting(false)
    }
  }

  function goDashboard() {
    try {
      localStorage.removeItem('restaurant_user')
      localStorage.removeItem('selectedRestaurant')
      localStorage.removeItem('selectedRestaurantName')
      sessionStorage.removeItem(SNAP_KEY)
    } catch { /* ignore */ }
    // Full-page navigation so the browser sends the disco_restaurant_token cookie.
    window.location.href = '/restaurant/orders'
  }

  function back() { setError(''); setStep(s => Math.max(0, s - 1)) }

  const errorBox = error ? (
    <div style={{ background: '#fff3f3', border: '1px solid #ffd6d6', color: '#c0392b', borderRadius: 12, padding: '10px 14px', fontSize: 13, margin: '0 0 14px' }}>
      {error}
    </div>
  ) : null

  return (
    <div style={{ minHeight: '100svh', background: 'linear-gradient(180deg,rgba(107,110,249,0.06) 0%,rgba(240,70,138,0.03) 220px,#fafafc 520px,#fafafc 100%)', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); * { box-sizing: border-box; }`}</style>

      {/* Top bar: back link (left) + step counter (right) */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '22px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 }}>
        {step >= 1 && step <= 6 ? (
          <button onClick={back} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#777', fontFamily: F, fontWeight: 600, padding: 0 }}>
            ‹ Back
          </button>
        ) : (
          <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
        )}
        {step <= 6 && (
          <div style={{ fontSize: 13, color: '#aaa', fontWeight: 700 }}>Step {step + 1} of 8</div>
        )}
      </div>

      {/* Logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '16px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#999' }}> cater</span>
        </Link>
      </div>

      {/* Step indicator — eight segments */}
      {step <= 6 && (
        <div style={{ maxWidth: 560, width: '100%', margin: '18px auto 0', padding: '0 24px', display: 'flex', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
            <div key={i} style={{ flex: 1, height: 5, borderRadius: 999, background: i <= step ? GRADIENT : '#e8e8f0', transition: 'background 0.2s' }} />
          ))}
        </div>
      )}

      {/* Card */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '24px 24px 64px' }}>
        <div style={{ width: '100%', maxWidth: 540 }}>

          {/* ── STEP 1 · CREATE YOUR ACCOUNT (collect only) ── */}
          {step === 0 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Create your account</h1>
              <p style={subStyle}>Let&apos;s start with your details. Signing up is fast and risk free.</p>
              {errorBox}
              <div style={{ marginTop: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="First name" value={form.firstName} onChange={v => set('firstName', v)} autoComplete="given-name" />
                  <Field label="Last name" value={form.lastName} onChange={v => set('lastName', v)} autoComplete="family-name" />
                </div>
                <Field label="Email" value={form.email} onChange={v => set('email', v)} type="email" autoComplete="email" />
                <Field label="Create a password" value={form.password} onChange={v => set('password', v)} type="password" autoComplete="new-password" />
                <div style={{ fontSize: 12, color: '#999', margin: '-6px 0 0', paddingLeft: 4 }}>Minimum 8 characters</div>
              </div>
              <button
                onClick={() => {
                  setError('')
                  if (!step0Valid) { setError('Please complete all fields (password must be 8+ characters).'); return }
                  setStep(1)
                }}
                disabled={!step0Valid}
                style={{ ...primaryBtn, marginTop: 8, opacity: step0Valid ? 1 : 0.5, cursor: step0Valid ? 'pointer' : 'default' }}>
                Next
              </button>
            </div>
          )}

          {/* ── STEP 2 · RESTAURANT INFO (collect only) ── */}
          {step === 1 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Restaurant info</h1>
              <p style={subStyle}>Start with 1 location and our team can help onboard the rest.</p>
              {errorBox}
              <div style={{ marginTop: 18 }}>
                <Field label="Restaurant name" value={form.restaurantName} onChange={v => set('restaurantName', v)} />
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Street address</label>
                  <input
                    ref={streetInputRef}
                    type="text" value={addr.street} placeholder="Start typing your address…"
                    onChange={e => setAddr(a => ({ ...a, street: e.target.value }))}
                    onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(91,111,232,0.12)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = '#e6e6ee'; e.currentTarget.style.boxShadow = 'none' }}
                    style={pillInput}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
                  <Field label="City" value={addr.city} onChange={v => setAddr(a => ({ ...a, city: v }))} />
                  <Field label="State" value={addr.state} onChange={v => setAddr(a => ({ ...a, state: v }))} />
                  <Field label="Zip" value={addr.zip} onChange={v => setAddr(a => ({ ...a, zip: v }))} />
                </div>
                <Field label="Phone (optional)" value={form.phoneNumber} onChange={v => set('phoneNumber', v)} type="tel" autoComplete="tel" />
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>Logo or photo (optional)</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1.5px dashed #d6d6e4', borderRadius: 14, cursor: 'pointer', background: '#fbfbfe' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: BLUE, whiteSpace: 'nowrap' }}>{logoUploading ? 'Uploading…' : 'Choose image'}</span>
                    <span style={{ fontSize: 13, color: logoUrl ? DARK : '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {logoUrl ? 'Uploaded ✓' : 'No image selected'}
                    </span>
                    <input type="file" accept="image/*" disabled={logoUploading}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f) }}
                      style={{ display: 'none' }} />
                  </label>
                </div>
              </div>
              <button
                onClick={() => {
                  setError('')
                  if (!step1Valid) { setError('Restaurant name and full address are required.'); return }
                  setStep(2)
                }}
                disabled={!step1Valid}
                style={{ ...primaryBtn, marginTop: 8, opacity: step1Valid ? 1 : 0.5, cursor: step1Valid ? 'pointer' : 'default' }}>
                Next
              </button>
            </div>
          )}

          {/* ── STEP 3 · PRICING: FIRST-PARTY (required) ── */}
          {step === 2 && (
            <div style={cardStyle}>
              <h1 style={h1Style}><span style={{ color: '#5B6FE8' }}>Pricing:</span> First-Party Ordering</h1>
              <p style={subStyle}>Orders placed through your website, social and other native links.</p>
              {errorBox}

              <div style={{ marginTop: 18 }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                  <div style={priceSectionTitle}>Paid by Restaurant</div>
                  <PriceRow label="First-Party orders" value="0.00%" />
                  <PriceRow label="Direct Entry orders" detail="Orders you enter yourself through your portal" value="0.00%" />
                  <PriceRow label="Stripe processing" detail="Per transaction" value="2.90% + $0.30" />
                </div>
              </div>

              {/* Required terms — no skip; must agree to continue */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 11, cursor: 'pointer', margin: '20px 0 18px' }}>
                <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>
                  I agree to the{' '}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Privacy Policy</a>
                </span>
              </label>

              <button onClick={() => { setError(''); setStep(3) }} disabled={!agree}
                style={{ ...primaryBtn, opacity: agree ? 1 : 0.5, cursor: agree ? 'pointer' : 'default' }}>
                Continue
              </button>
            </div>
          )}

          {/* ── STEP 4 · PRICING: MARKETPLACE (optional) ── */}
          {step === 3 && (
            <div style={cardStyle}>
              <h1 style={h1Style}><span style={{ color: '#5B6FE8' }}>Pricing:</span> Marketplace (Optional)</h1>
              <p style={subStyle}>We send you new catering orders through the Disco Cater network of corporate and social customers. Fees only apply when we are the source of the order.</p>
              {errorBox}

              <div style={{ marginTop: 18, border: '1px solid #ececf4', borderRadius: 16, padding: '4px 18px 14px' }}>
                <PriceRow label="First-time customers" detail="Of order subtotal — the first time a new customer orders from a unique location" value="15.00%" who="restaurant" />
                <PriceRow label="Returning customers" detail="Of order subtotal — that customer's subsequent orders from that location" value="5.00%" who="restaurant" />
              </div>
              <div style={{ fontSize: 12, color: '#999', margin: '10px 2px 0', lineHeight: 1.5 }}>
                All First-Party ordering fees apply.
              </div>

              <button onClick={() => { setError(''); setJoinedMarketplace(true); setStep(4) }}
                style={{ ...primaryBtn, marginTop: 22 }}>
                Join Marketplace
              </button>
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => { setError(''); setJoinedMarketplace(false); setStep(4) }} style={linkBtn}>
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 5 · THIRD-PARTY DELIVERY (optional) ── */}
          {step === 4 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Third-Party Delivery (Optional)</h1>
              <p style={subStyle}>Offer your customers catering-specific delivery drivers, automatically dispatched when they choose delivery at checkout.</p>
              {errorBox}

              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {['Catering-specific drivers', '15% of Subtotal, $85 cap', 'Setup included', 'Proactive support'].map(b => (
                  <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: DARK, fontWeight: 600 }}>
                    <span style={{ color: '#2E9E5B', fontWeight: 800 }}>✓</span> {b}
                  </div>
                ))}
              </div>

              <button onClick={() => { setError(''); setDeliveryEnabled(true); setStep(5) }}
                style={{ ...primaryBtn, marginTop: 24 }}>
                Enable Third-Party Delivery
              </button>
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => { setError(''); setDeliveryEnabled(false); setStep(5) }} style={linkBtn}>
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 6 · CONNECT STRIPE (skippable) ── */}
          {step === 5 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Connect Stripe for payouts</h1>
              <p style={subStyle}>Connect your bank account through Stripe to receive payouts from catering orders.</p>
              {errorBox}

              <div style={{ marginTop: 18 }}>
                {stripeConnected ? (
                  <>
                    <button disabled
                      style={{ ...primaryBtn, background: '#2E9E5B', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                      ✓ Stripe connected
                    </button>
                    <button onClick={() => { setError(''); setStep(6) }} style={{ ...primaryBtn, marginTop: 12 }}>
                      Continue
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={connectStripe} disabled={loading}
                      style={{ ...primaryBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
                      {loading ? 'Connecting…' : <>Connect to <span style={{ fontWeight: 800, fontStyle: 'italic' }}>Stripe</span> →</>}
                    </button>
                    {/* Skippable — banking can be set up later from the dashboard. */}
                    <div style={{ textAlign: 'center', marginTop: 14 }}>
                      <button onClick={() => { setError(''); setStep(6) }} style={linkBtn}>
                        Skip for now
                      </button>
                      <p style={{ fontSize: 12, color: '#999', margin: '8px auto 0', maxWidth: 360, lineHeight: 1.5 }}>
                        You can set up banking anytime from your dashboard under Account → Banking.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 7 · UPLOAD YOUR MENU (optional) ── */}
          {step === 6 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Upload your menu</h1>
              <p style={subStyle}>Upload a PDF or paste a link and our AI will set it up. You can add menu items anytime from your dashboard.</p>
              {errorBox}

              {menuProcessing ? (
                <div style={{ marginTop: 24, textAlign: 'center', padding: '28px 10px' }}>
                  <div style={{
                    width: 36, height: 36, margin: '0 auto 16px', borderRadius: '50%',
                    border: '3px solid #ececf4', borderTopColor: BLUE, animation: 'discospin 0.8s linear infinite',
                  }} />
                  <style>{`@keyframes discospin { to { transform: rotate(360deg) } }`}</style>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Our AI is reading your menu…</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 6 }}>This usually takes 10–30 seconds.</div>
                </div>

              ) : menuResult?.confidence === 'high' ? (
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#2E9E5B', marginBottom: 10 }}>
                    ✓ We found {menuResult.items.length} item{menuResult.items.length === 1 ? '' : 's'} on your menu
                  </div>
                  <div style={{ border: '1px solid #ececf4', borderRadius: 14, overflow: 'hidden', maxHeight: 280, overflowY: 'auto' }}>
                    {menuResult.items.map((it, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : '1px solid #f1f1f6' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: DARK, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</div>
                          {it.serves && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>Serves {it.serves}</div>}
                        </div>
                        {it.price > 0 && <div style={{ fontSize: 14, fontWeight: 800, color: BLUE, whiteSpace: 'nowrap', flexShrink: 0 }}>${it.price.toFixed(2)}</div>}
                      </div>
                    ))}
                  </div>
                  <p style={{ ...subStyle, margin: '14px 0 0' }}>Looks good! We&apos;ll finish setting up your menu.</p>
                  <button onClick={() => setStep(7)} style={{ ...primaryBtn, marginTop: 18 }}>Continue</button>
                </div>

              ) : menuResult?.confidence === 'low' ? (
                <div style={{ marginTop: 18 }}>
                  <div style={{ background: '#f4f6ff', border: '1px solid #dfe4ff', borderRadius: 14, padding: '18px 18px' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>We&apos;ll set up your menu for you</div>
                    <p style={{ fontSize: 13.5, color: '#585786', lineHeight: 1.6, margin: '6px 0 0' }}>
                      Our team will be in touch to help finish setting up your catering menu.
                    </p>
                  </div>
                  <button onClick={() => setStep(7)} style={{ ...primaryBtn, marginTop: 18 }}>Continue</button>
                </div>

              ) : (
                <>
                  <div style={{ marginTop: 18, display: 'flex', gap: 8, background: '#f4f4fa', borderRadius: 999, padding: 4 }}>
                    {([['pdf', 'Upload PDF'], ['url', 'Paste a URL']] as const).map(([key, label]) => (
                      <button key={key} onClick={() => { setError(''); setMenuTab(key) }}
                        style={{
                          flex: 1, height: 38, borderRadius: 999, border: 'none', cursor: 'pointer',
                          fontFamily: F, fontSize: 13.5, fontWeight: 700,
                          background: menuTab === key ? '#fff' : 'transparent',
                          color: menuTab === key ? DARK : '#888',
                          boxShadow: menuTab === key ? '0 1px 4px rgba(26,16,40,0.1)' : 'none',
                        }}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {menuTab === 'pdf' ? (
                    <div style={{ marginTop: 16 }}>
                      <label style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                        border: '1.5px dashed #d6d6e4', borderRadius: 14, cursor: 'pointer', background: '#fbfbfe',
                      }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: BLUE, whiteSpace: 'nowrap' }}>Choose PDF</span>
                        <span style={{ fontSize: 13, color: menuFile ? DARK : '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {menuFile ? menuFile.name : 'No file selected'}
                        </span>
                        <input type="file" accept=".pdf,application/pdf"
                          onChange={e => setMenuFile(e.target.files?.[0] || null)}
                          style={{ display: 'none' }} />
                      </label>
                    </div>
                  ) : (
                    <div style={{ marginTop: 16 }}>
                      <input
                        type="url" value={menuUrl} placeholder="https://www.ezcater.com/…  or your menu page"
                        onChange={e => setMenuUrl(e.target.value)}
                        onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(91,111,232,0.12)' }}
                        onBlur={e => { e.currentTarget.style.borderColor = '#e6e6ee'; e.currentTarget.style.boxShadow = 'none' }}
                        style={pillInput}
                      />
                    </div>
                  )}

                  <button onClick={processMenu} style={{ ...primaryBtn, marginTop: 24 }}>
                    Upload Menu
                  </button>

                  <div style={{ textAlign: 'center', marginTop: 12 }}>
                    <button onClick={skipMenu} style={linkBtn}>
                      Skip for now
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── STEP 8 · YOU'RE LIVE (fires /complete) ── */}
          {step === 7 && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 30px' }}>
              {completing ? (
                <div style={{ padding: '20px 0' }}>
                  <div style={{
                    width: 36, height: 36, margin: '0 auto 16px', borderRadius: '50%',
                    border: '3px solid #ececf4', borderTopColor: BLUE, animation: 'discospin 0.8s linear infinite',
                  }} />
                  <style>{`@keyframes discospin { to { transform: rotate(360deg) } }`}</style>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Setting up your account…</div>
                  <div style={{ fontSize: 13, color: '#888', marginTop: 6 }}>Just a moment.</div>
                </div>
              ) : completed ? (
                <>
                  <h1 style={{ ...h1Style, fontSize: 28 }}>Welcome to Disco Cater! 🎉</h1>
                  <p style={{ ...subStyle, maxWidth: 440, margin: '0 auto 8px' }}>
                    Your account is ready and you&apos;re all set to start taking catering orders.
                  </p>
                  <button onClick={goDashboard}
                    style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', marginTop: 24, cursor: 'pointer' }}>
                    Go to My Dashboard
                  </button>
                  <p style={{ fontSize: 12, color: '#999', maxWidth: 420, margin: '18px auto 0', lineHeight: 1.6 }}>
                    Questions? Feel free to email our team at concierge@discocater.com
                  </p>
                </>
              ) : (
                <>
                  <h1 style={{ ...h1Style, fontSize: 24 }}>Almost there</h1>
                  {errorBox}
                  <p style={{ ...subStyle, maxWidth: 440, margin: '0 auto 8px' }}>
                    We couldn&apos;t finish setting up your account. Your progress is saved — please try again.
                  </p>
                  <button onClick={completeOnboarding}
                    style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', marginTop: 16, cursor: 'pointer' }}>
                    Try again
                  </button>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
