'use client'
import { useState, useEffect } from 'react'
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
const h1Style: React.CSSProperties = { fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const subStyle: React.CSSProperties = { fontSize: 14, color: '#585786', lineHeight: 1.6, margin: '0 0 8px' }
const cardStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #ececf4', borderRadius: 20,
  boxShadow: '0 10px 40px rgba(26,16,40,0.06)', padding: '28px 26px',
}
// Section header inside a pricing card ("Paid by Restaurant" / "Paid by Customer").
const priceSectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#5B6FE8', textTransform: 'uppercase',
  letterSpacing: 0.5, padding: '12px 0 2px',
}

interface FormState {
  firstName: string; lastName: string; email: string; phoneNumber: string
  restaurantName: string; zip: string; password: string
}

// One parsed menu item returned by the AI menu-import route (high confidence).
interface MenuItem {
  name: string; description: string; price: number; serves: string; category: string
}

// ── Per-email onboarding cache ────────────────────────────────────────────────
// These keys persist the "this browser already created the restaurant" state so
// we never provision twice across the Stripe round-trip reload. They MUST be
// scoped to the email — an unscoped key on a shared browser would let the next
// person's onboarding reuse the previous person's restaurantRef.
const PARTNER_KEY_PREFIXES = ['partner_setup_complete', 'partner_restaurant_ref', 'partner_restaurant_slug']
const emailKey = (email: string) => email.trim().toLowerCase()
const setupCompleteKey = (email: string) => `partner_setup_complete_${emailKey(email)}`
const restaurantRefKey = (email: string) => `partner_restaurant_ref_${emailKey(email)}`

// Remove every partner setup key (legacy unscoped + any email-scoped variant)
// that doesn't belong to keepEmail. Pass '' to purge them all. The separate
// `partner_onboarding` snapshot is intentionally left untouched.
function purgeStalePartnerKeys(keepEmail: string) {
  const keep = keepEmail ? PARTNER_KEY_PREFIXES.map(p => `${p}_${emailKey(keepEmail)}`) : []
  try {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      const isPartnerSetupKey = PARTNER_KEY_PREFIXES.some(p => key === p || key.startsWith(`${p}_`))
      if (isPartnerSetupKey && !keep.includes(key)) toRemove.push(key)
    }
    toRemove.forEach(k => localStorage.removeItem(k))
  } catch { /* localStorage unavailable */ }
}

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

export default function BecomeAPartnerClient() {
  // Steps: 0 your info · 1 first-party pricing · 2 marketplace (opt) ·
  // 3 third-party delivery (opt) · 4 connect bank/Stripe (opt) · 5 upload menu ·
  // 6 success.
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', email: '', phoneNumber: '',
    restaurantName: '', zip: '', password: '',
  })
  const [agree1P, setAgree1P] = useState(false)          // required (step 2)
  const [agreeMarketplace, setAgreeMarketplace] = useState(false) // opt-in (step 3)
  const [joinedMarketplace, setJoinedMarketplace] = useState(false)
  const [deliveryEnabled, setDeliveryEnabled] = useState(false)   // step 4 (3P delivery)
  const [stripeConnected, setStripeConnected] = useState(false)   // step 5 (Stripe Connect)
  // Menu step (step 5): AI import with graceful concierge fallback.
  const [menuTab, setMenuTab] = useState<'pdf' | 'url'>('pdf')
  const [menuFile, setMenuFile] = useState<File | null>(null)
  const [menuUrl, setMenuUrl] = useState('')
  const [menuProcessing, setMenuProcessing] = useState(false)
  // null = not processed yet. 'high' shows the parsed preview; 'low' shows the
  // concierge-handoff message. Either way the partner continues to success.
  const [menuResult, setMenuResult] = useState<null | { confidence: 'high' | 'low'; items: MenuItem[] }>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [emailInUse, setEmailInUse] = useState(false)   // FM 400-027: admin email already exists
  const [autoLoggedIn, setAutoLoggedIn] = useState(false) // Disco-native session created
  // The restaurant is created ONCE — at the Stripe step if the partner connects,
  // otherwise at completion. alreadyCreated guards against creating it twice.
  const [alreadyCreated, setAlreadyCreated] = useState(false)
  const [restaurantRef, setRestaurantRef] = useState('')

  const set = (k: keyof FormState, v: string) => setForm(p => ({ ...p, [k]: v }))

  // On mount: never trust a persisted "already created" flag — the form email
  // isn't known yet, so we can't tell whose cache it is. Default alreadyCreated
  // OFF; it's only set after the form email is confirmed during the flow. The
  // ONE exception is the Stripe Connect return (?stripe=success), where the
  // snapshot tells us the session email and we restore that email's state.
  useEffect(() => {
    setAlreadyCreated(false)
    let sessionEmail = ''
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('stripe') === 'success') {
        const saved = JSON.parse(localStorage.getItem('partner_onboarding') || '{}')
        sessionEmail = String(saved?.form?.email || '')
        if (saved.form) setForm(f => ({ ...f, ...saved.form }))
        if (typeof saved.joinedMarketplace === 'boolean') setJoinedMarketplace(saved.joinedMarketplace)
        if (typeof saved.deliveryEnabled === 'boolean') setDeliveryEnabled(saved.deliveryEnabled)
        setStripeConnected(true)
        setStep(4)
        window.history.replaceState({}, '', '/become-a-partner')
      }
    } catch { /* snapshot optional */ }

    // Purge any partner setup keys not belonging to this session (everything on
    // a fresh visit) so a shared browser never reuses a prior user's restaurant.
    purgeStalePartnerKeys(sessionEmail)

    // Stripe round-trip only: the create step ran before the redirect, so the
    // Disco account+session already exist for this email — restore that state
    // (lost on the reload) for the success-screen dashboard link.
    try {
      if (sessionEmail && localStorage.getItem(setupCompleteKey(sessionEmail)) === 'true') {
        setAlreadyCreated(true)
        setAutoLoggedIn(true)
        const ref = localStorage.getItem(restaurantRefKey(sessionEmail)) || ''
        if (ref) setRestaurantRef(ref)
      }
    } catch { /* localStorage unavailable */ }
  }, [])

  // Confirm the auto-login state once the success screen renders.
  useEffect(() => {
    if (step === 6) console.log('[become-a-partner] success screen autoLoggedIn:', autoLoggedIn)
  }, [step, autoLoggedIn])

  // After returning from Stripe we briefly show "✓ Stripe connected" on the
  // Stripe step, then advance to the menu step automatically.
  useEffect(() => {
    if (step === 4 && stripeConnected) {
      const id = setTimeout(() => setStep(5), 1500)
      return () => clearTimeout(id)
    }
  }, [step, stripeConnected])

  const infoValid = !!form.firstName && !!form.lastName && !!form.email
    && !!form.phoneNumber && !!form.restaurantName && !!form.zip && !!form.password

  // ── Step 1 → just validate and advance. The restaurant (and its ADMIN account)
  // is NOT created here — creation is deferred to completeOnboarding so partial
  // signups never provision FM accounts or trigger Slack/email notifications. ──
  function registerAccount() {
    setError(''); setEmailInUse(false)
    if (!infoValid) { setError('Please complete all fields.'); return }
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return }
    setStep(1)
  }

  // Create the restaurant. FM provisions the ADMIN account from `admin` (email +
  // the password the partner set) using our SUPER_ADMIN service account. Returns
  // the new restaurant reference on success, or null on failure (and sets the
  // appropriate error). Persists a flag so a repeat run won't create a duplicate.
  async function createRestaurant(): Promise<string | null> {
    console.log('[onboarding] createRestaurant called for:', form.restaurantName, form.email)
    try {
      const res = await fetch('/api/become-a-partner/create-restaurant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantName: form.restaurantName, email: form.email,
          phoneNumber: form.phoneNumber, firstName: form.firstName,
          lastName: form.lastName, zipcode: form.zip, password: form.password,
        }),
      })
      const data = await res.json().catch(() => null)
      console.log('[onboarding] create-restaurant response:', res.status, data)
      if (!res.ok || !data?.restaurantReference) {
        // FM 400-027 → a restaurant admin with this email already exists.
        if (data?.code === '400-027') {
          setEmailInUse(true)
          setError('An account with this email already exists. Please log in to your restaurant portal at discocater.com/restaurant/login.')
          return null
        }
        setError(data?.error || 'Could not create your restaurant. Please try again or contact concierge@discocater.com.')
        return null
      }
      const ref = String(data.restaurantReference)
      setRestaurantRef(ref)
      setAlreadyCreated(true)
      try {
        // Scope the cache to this email so a shared browser can't reuse this
        // restaurantRef for the next person's onboarding.
        localStorage.setItem(setupCompleteKey(form.email), 'true')
        localStorage.setItem(restaurantRefKey(form.email), ref)
      } catch { /* localStorage unavailable */ }
      // Create the Disco-native account + session (sets disco_restaurant_token)
      // so the partner is logged into the portal immediately.
      console.log('[onboarding] calling registerDiscoAccount for ref:', ref)
      const registered = await registerDiscoAccount(ref, data?.adminReference ?? null)
      console.log('[onboarding] registerDiscoAccount result:', registered, 'autoLoggedIn:', autoLoggedIn)
      return ref
    } catch {
      setError('Unable to connect. Please try again.')
      return null
    }
  }

  // Create a Disco-native restaurant account + session right after the FM
  // restaurant exists. Sets the httpOnly disco_restaurant_token cookie. Runs
  // exactly once (inside createRestaurant) and is best-effort — never blocks.
  async function registerDiscoAccount(ref: string, fmUserReference: string | null): Promise<boolean> {
    try {
      const res = await fetch('/api/disco-restaurant-auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: form.email, password: form.password,
          firstName: form.firstName, lastName: form.lastName,
          phone: form.phoneNumber, restaurantName: form.restaurantName,
          restaurantReference: ref, fmUserReference: fmUserReference || undefined,
        }),
      })
      if (res.ok) {
        setAutoLoggedIn(true)
        // Drop any stale FM restaurant identity so the portal header + data scope
        // to the new Disco restaurant, not a previously logged-in FM one. The
        // portal layout repopulates from /api/disco-restaurant-auth/me.
        try {
          localStorage.removeItem('restaurant_user')
          localStorage.removeItem('selectedRestaurant')
          localStorage.removeItem('selectedRestaurantName')
        } catch {}
        return true
      } else {
        console.error('[become-a-partner] disco register failed:', res.status)
        return false
      }
    } catch (err) {
      console.error('[become-a-partner] disco register request failed:', err)
      return false
    }
  }

  // Stripe step → ensure the restaurant exists (create it now if needed), then
  // start Stripe Connect via the SUPER_ADMIN service account and redirect. We
  // save a snapshot first because the Stripe redirect reloads this page.
  async function connectStripe() {
    setError('')
    setLoading(true)
    try {
      let ref = restaurantRef
      if (!alreadyCreated) {
        const created = await createRestaurant()
        if (!created) { setLoading(false); return }
        ref = created
      }
      try { localStorage.setItem('partner_onboarding', JSON.stringify({ form, joinedMarketplace, deliveryEnabled })) } catch {}
      const res = await fetch('/api/become-a-partner/stripe-connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantReference: ref }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.stripeConnectUrl) {
        setError(data?.error || 'Could not start Stripe Connect. You can connect later from your dashboard.')
        setLoading(false)
        return
      }
      window.location.href = data.stripeConnectUrl // redirect; page unloads
    } catch {
      setError('Could not start Stripe Connect. You can connect later from your dashboard.')
      setLoading(false)
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

  // AI menu import. Sends the PDF (base64) or URL to /menu-upload, which parses
  // it with Claude. HIGH confidence → preview the parsed items; LOW confidence
  // (or any error) → the route has already emailed the concierge team, and we
  // show the "we'll set it up for you" handoff. Either way onboarding continues —
  // the partner never sees a failure.
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
        // Low confidence, a non-OK response, or a parse error — all resolve to the
        // graceful concierge handoff. The route emails the team server-side.
        setMenuResult({ confidence: 'low', items: [] })
      }
    } catch (err) {
      // Network failure reaching our own route — still hand off gracefully.
      console.error('[become-a-partner] menu processing request failed:', err)
      setMenuResult({ confidence: 'low', items: [] })
    } finally {
      setMenuProcessing(false)
    }
  }

  // Tell the team the partner skipped the menu step, then finish onboarding.
  // Best-effort — a failed note must never block completion.
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
    await completeOnboarding()
  }

  // ── Final step → create the restaurant (deferred from step 0), then fire the
  // team notification and show success. The menu was already handled (parsed or
  // handed to concierge) on the menu step, so it isn't touched here. This is the
  // ONLY place that provisions FM, so partial signups never create accounts. ──
  async function completeOnboarding() {
    console.log('[onboarding] completeOnboarding called, restaurantRef:', restaurantRef, 'alreadyCreated:', alreadyCreated)
    setError('')
    setLoading(true)
    try {
      // Create the FM restaurant + ADMIN now, unless this browser already did
      // (e.g. at the Stripe step, or on a previous completed run).
      let ref = restaurantRef
      if (!alreadyCreated) {
        const created = await createRestaurant()
        if (!created) return // createRestaurant set the error (incl. email-in-use)
        ref = created
      }
      const res = await fetch('/api/become-a-partner/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Full context for the team notification (email + Slack). agreedToPricing
        // = the required First Party terms.
        body: JSON.stringify({
          restaurantName: form.restaurantName,
          email: form.email,
          phone: form.phoneNumber,
          zip: form.zip,
          joinedMarketplace,
          deliveryEnabled,
          stripeConnected,
          restaurantReference: ref,
          menuFileName: menuTab === 'pdf' ? (menuFile?.name || '') : (menuUrl.trim() || ''),
          agreedToPricing: true,
          agreedToDelivery: deliveryEnabled,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error || 'Something went wrong. Please try again.'); return }
      setStep(6)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
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
        {step >= 1 && step <= 5 ? (
          <button onClick={back} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#777', fontFamily: F, fontWeight: 600, padding: 0 }}>
            ‹ Back
          </button>
        ) : (
          <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
        )}
        {step <= 5 && (
          <div style={{ fontSize: 13, color: '#aaa', fontWeight: 700 }}>Step {step + 1} of 6</div>
        )}
      </div>

      {/* Logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '16px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#999' }}> cater</span>
        </Link>
      </div>

      {/* Step indicator — six segments */}
      {step <= 5 && (
        <div style={{ maxWidth: 560, width: '100%', margin: '18px auto 0', padding: '0 24px', display: 'flex', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} style={{ flex: 1, height: 5, borderRadius: 999, background: i <= step ? GRADIENT : '#e8e8f0', transition: 'background 0.2s' }} />
          ))}
        </div>
      )}

      {/* Card */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '24px 24px 64px' }}>
        <div style={{ width: '100%', maxWidth: 540 }}>

          {/* ── STEP 1 · YOUR INFO ── */}
          {step === 0 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Let&apos;s get you set up</h1>
              <p style={subStyle}>Tell us about you and your restaurant. Signing up is fast and risk free.</p>
              {emailInUse ? (
                <div style={{ background: '#fff8ec', border: '1px solid #f5e2b8', color: '#8a6d2f', borderRadius: 12, padding: '12px 14px', fontSize: 13, lineHeight: 1.5, margin: '0 0 14px' }}>
                  An account with this email already exists. Please{' '}
                  <a href="/restaurant/login" style={{ color: '#5B6FE8', fontWeight: 700 }}>log in to your restaurant portal</a>
                  {' '}instead.
                </div>
              ) : errorBox}
              <div style={{ marginTop: 18 }}>
                <Field label="Restaurant name" value={form.restaurantName} onChange={v => set('restaurantName', v)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="First name" value={form.firstName} onChange={v => set('firstName', v)} autoComplete="given-name" />
                  <Field label="Last name" value={form.lastName} onChange={v => set('lastName', v)} autoComplete="family-name" />
                </div>
                <Field label="Email" value={form.email} onChange={v => set('email', v)} type="email" autoComplete="email" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Phone" value={form.phoneNumber} onChange={v => set('phoneNumber', v)} type="tel" autoComplete="tel" />
                  <Field label="Zip code" value={form.zip} onChange={v => set('zip', v)} autoComplete="postal-code" />
                </div>
                <Field label="Create a password" value={form.password} onChange={v => set('password', v)} type="password" autoComplete="new-password" />
                <div style={{ fontSize: 12, color: '#999', margin: '-6px 0 0', paddingLeft: 4 }}>Minimum 8 characters</div>
              </div>
              <button onClick={registerAccount} disabled={!infoValid}
                style={{ ...primaryBtn, marginTop: 8, opacity: infoValid ? 1 : 0.5, cursor: infoValid ? 'pointer' : 'default' }}>
                Continue
              </button>
            </div>
          )}

          {/* ── STEP 2 · FIRST PARTY (1P) — required ── */}
          {step === 1 && (
            <div style={cardStyle}>
              <h1 style={h1Style}><span style={{ color: '#5B6FE8' }}>Pricing:</span> First-Party Ordering</h1>
              <p style={subStyle}>Orders placed through your website, social and other native links.</p>
              {errorBox}

              {/* 1P pricing — a separate bubble per "who pays" group */}
              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                  <div style={priceSectionTitle}>Paid by Restaurant</div>
                  <PriceRow label="First-Party orders" value="0.00%" />
                  <PriceRow label="Direct Entry orders" detail="Orders you enter yourself through your portal" value="0.00%" />
                  <PriceRow label="Stripe processing" detail="Per transaction" value="2.90% + $0.30" />
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                  <div style={priceSectionTitle}>Paid by Customer</div>
                  <PriceRow label="Customer convenience fee" detail="Added at checkout" value="3.00%" />
                  <PriceRow label="Third-party delivery" value="Paid by customer" />
                </div>
              </div>

              {/* Required agreement */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 11, cursor: 'pointer', margin: '20px 0 18px' }}>
                <input type="checkbox" checked={agree1P} onChange={e => setAgree1P(e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>
                  I agree to the{' '}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Disco Cater Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Privacy Policy</a>
                </span>
              </label>

              <button onClick={() => { setError(''); setStep(2) }} disabled={!agree1P}
                style={{ ...primaryBtn, opacity: agree1P ? 1 : 0.5, cursor: agree1P ? 'pointer' : 'default' }}>
                Continue
              </button>
            </div>
          )}

          {/* ── STEP 3 · MARKETPLACE (3P) — optional ── */}
          {step === 2 && (
            <div style={cardStyle}>
              <h1 style={h1Style}><span style={{ color: '#5B6FE8' }}>Pricing:</span> Marketplace (Optional)</h1>
              <p style={subStyle}>We send you new catering orders through the Disco Cater network of corporate and social customers. Fees only apply when we are the source of the order.</p>
              {errorBox}

              {/* 3P pricing — lead-gen fees only; all the First-Party fees still apply. */}
              <div style={{ marginTop: 18, border: '1px solid #ececf4', borderRadius: 16, padding: '4px 18px 14px' }}>
                <PriceRow label="First-time customers" detail="Of order subtotal — the first time a new customer orders from a unique location" value="15.00%" who="restaurant" />
                <PriceRow label="Returning customers" detail="Of order subtotal — that customer's subsequent orders from that location" value="5.00%" who="restaurant" />
              </div>
              <div style={{ fontSize: 12, color: '#999', margin: '10px 2px 0', lineHeight: 1.5 }}>
                All First-Party ordering fees apply. See above.
              </div>

              {/* Opt-in agreement (only required to join) */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 11, cursor: 'pointer', margin: '20px 0 18px' }}>
                <input type="checkbox" checked={agreeMarketplace} onChange={e => setAgreeMarketplace(e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>I agree to the Disco Cater Marketplace Terms</span>
              </label>

              <button onClick={() => { setError(''); setJoinedMarketplace(true); setStep(3) }} disabled={!agreeMarketplace}
                style={{ ...primaryBtn, opacity: agreeMarketplace ? 1 : 0.5, cursor: agreeMarketplace ? 'pointer' : 'default' }}>
                Join Marketplace
              </button>
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => { setError(''); setJoinedMarketplace(false); setStep(3) }}
                  style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600, fontFamily: F, cursor: 'pointer', textDecoration: 'underline' }}>
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 4 · THIRD-PARTY DELIVERY — optional ── */}
          {step === 3 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Third-Party Delivery (Optional)</h1>
              <p style={subStyle}>Offer your customers catering-specific delivery drivers, automatically dispatched when they choose delivery at checkout.</p>
              {errorBox}

              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {['Catering-specific drivers', 'Setup included', 'Proactive support'].map(b => (
                  <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: DARK, fontWeight: 600 }}>
                    <span style={{ color: '#2E9E5B', fontWeight: 800 }}>✓</span> {b}
                  </div>
                ))}
              </div>

              <button onClick={() => { setError(''); setDeliveryEnabled(true); setStep(4) }}
                style={{ ...primaryBtn, marginTop: 24 }}>
                Enable third-party delivery
              </button>
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => { setError(''); setDeliveryEnabled(false); setStep(4) }}
                  style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600, fontFamily: F, cursor: 'pointer', textDecoration: 'underline' }}>
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 5 · CONNECT BANK / STRIPE — optional ── */}
          {step === 4 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Payout Setup (Optional)</h1>
              <p style={subStyle}>Connect your bank account to receive payouts from catering orders. You can also complete this from your Account tab any time.</p>
              {errorBox}

              <div style={{ marginTop: 18 }}>
                {stripeConnected ? (
                  <button disabled
                    style={{ ...primaryBtn, background: '#2E9E5B', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    ✓ Stripe connected
                  </button>
                ) : (
                  <button onClick={connectStripe} disabled={loading}
                    style={{ ...primaryBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
                    {loading ? 'Connecting…' : <>Connect to <span style={{ fontWeight: 800, fontStyle: 'italic' }}>Stripe</span> →</>}
                  </button>
                )}
              </div>

              {!stripeConnected && (
                <div style={{ textAlign: 'center', marginTop: 12 }}>
                  <button onClick={() => { setError(''); setStep(5) }}
                    style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600, fontFamily: F, cursor: 'pointer', textDecoration: 'underline' }}>
                    Skip for now
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 6 · ADD YOUR MENU (AI import) ── */}
          {step === 5 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Add your menu</h1>
              <p style={subStyle}>Upload a PDF or paste a link to your menu.</p>
              {errorBox}

              {/* While the AI is reading the menu */}
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
                /* HIGH confidence → preview the parsed items */
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
                  <button onClick={completeOnboarding} disabled={loading}
                    style={{ ...primaryBtn, marginTop: 18, opacity: loading ? 0.6 : 1, cursor: loading ? 'default' : 'pointer' }}>
                    {loading ? 'Finishing up…' : 'Continue'}
                  </button>
                </div>

              ) : menuResult?.confidence === 'low' ? (
                /* LOW confidence → graceful concierge handoff (failure hidden) */
                <div style={{ marginTop: 18 }}>
                  <div style={{ background: '#f4f6ff', border: '1px solid #dfe4ff', borderRadius: 14, padding: '18px 18px' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: DARK }}>We&apos;ll set up your menu for you</div>
                    <p style={{ fontSize: 13.5, color: '#585786', lineHeight: 1.6, margin: '6px 0 0' }}>
                      Our team will be in touch to help finish setting up your catering menu.
                    </p>
                  </div>
                  <button onClick={completeOnboarding} disabled={loading}
                    style={{ ...primaryBtn, marginTop: 18, opacity: loading ? 0.6 : 1, cursor: loading ? 'default' : 'pointer' }}>
                    {loading ? 'Finishing up…' : 'Continue'}
                  </button>
                </div>

              ) : (
                /* Initial input: PDF / URL tabs + Process Menu */
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

                  <button onClick={processMenu}
                    style={{ ...primaryBtn, marginTop: 24 }}>
                    Process Menu
                  </button>

                  <div style={{ textAlign: 'center', marginTop: 12 }}>
                    <button onClick={skipMenu} disabled={loading}
                      style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600, fontFamily: F, cursor: loading ? 'default' : 'pointer', textDecoration: 'underline' }}>
                      Skip for now
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── SUCCESS ── */}
          {step === 6 && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 30px' }}>
              {void console.log('[onboarding] success screen, autoLoggedIn:', autoLoggedIn, 'restaurantRef:', restaurantRef)}
              <h1 style={{ ...h1Style, fontSize: 28 }}>You&apos;re all set! 🎉</h1>
              <p style={{ ...subStyle, maxWidth: 440, margin: '0 auto 8px' }}>
                Your account has been created.
                <br />
                Before activating online ordering, make sure your menu, ordering settings and Stripe connection are complete.
              </p>

              {/* Clear any stale FM identity, then navigate. Auto-logged-in via
                  disco_restaurant_token → dashboard; otherwise the login page. */}
              <button
                onClick={() => {
                  try {
                    localStorage.removeItem('restaurant_user')
                    localStorage.removeItem('selectedRestaurant')
                    localStorage.removeItem('selectedRestaurantName')
                  } catch {}
                  // Full-page navigation (not router.push) so the browser sends
                  // the disco_restaurant_token cookie set by the register
                  // response — a client-side transition may race the cookie.
                  window.location.href = autoLoggedIn ? '/restaurant/dashboard' : '/restaurant/login'
                }}
                style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', marginTop: 24, cursor: 'pointer' }}>
                Get started
              </button>

              <p style={{ fontSize: 12, color: '#999', maxWidth: 420, margin: '18px auto 0', lineHeight: 1.6 }}>
                Questions? Feel free to email our team at concierge@discocater.com
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
