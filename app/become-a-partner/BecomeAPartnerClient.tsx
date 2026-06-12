'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
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

interface FormState {
  firstName: string; lastName: string; email: string; phoneNumber: string
  restaurantName: string; zip: string; password: string
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
  const router = useRouter()
  // 0 = your info, 1 = first party (1P), 2 = marketplace (3P, optional),
  // 3 = connect bank (Stripe), 4 = upload menu, 5 = success.
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', email: '', phoneNumber: '',
    restaurantName: '', zip: '', password: '',
  })
  const [agree1P, setAgree1P] = useState(false)          // required (step 2)
  const [agreeMarketplace, setAgreeMarketplace] = useState(false) // opt-in (step 3)
  const [joinedMarketplace, setJoinedMarketplace] = useState(false)
  const [menuFile, setMenuFile] = useState<File | null>(null)
  const [stripeConnected, setStripeConnected] = useState(false)
  const [restaurantRef, setRestaurantRef] = useState('')      // FM ref from create-restaurant
  const [restaurantSlug, setRestaurantSlug] = useState('')    // businessNameWithoutSpaces (snapshot only)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof FormState, v: string) => setForm(p => ({ ...p, [k]: v }))

  // Recover the restaurant reference on every step change. createRestaurant()
  // stores it in localStorage; React state is lost on a full page refresh, so if
  // state is empty we re-read it here — keeps Stripe Connect working even if the
  // partner reloads the tab between steps.
  useEffect(() => {
    if (restaurantRef) return
    try {
      const ref = localStorage.getItem('partner_restaurant_ref') || ''
      if (ref) setRestaurantRef(ref)
    } catch { /* localStorage may be unavailable */ }
  }, [step, restaurantRef])

  // Handle the Stripe Connect return. The redirect to Stripe full-page-reloads
  // this component (state is lost), so we restore the in-progress onboarding
  // snapshot saved before the redirect, mark Stripe connected, land back on the
  // Menu & Banking step, and strip the ?stripe=success param from the URL.
  useEffect(() => {
    let params: URLSearchParams
    try { params = new URLSearchParams(window.location.search) } catch { return }
    if (params.get('stripe') !== 'success') return
    try {
      const saved = JSON.parse(localStorage.getItem('partner_onboarding') || '{}')
      if (saved.form) setForm(f => ({ ...f, ...saved.form }))
      if (typeof saved.joinedMarketplace === 'boolean') setJoinedMarketplace(saved.joinedMarketplace)
      if (saved.restaurantSlug) setRestaurantSlug(saved.restaurantSlug)
      const ref = localStorage.getItem('partner_restaurant_ref') || saved.restaurantRef || ''
      if (ref) setRestaurantRef(ref)
    } catch { /* snapshot optional */ }
    setStripeConnected(true)
    setStep(3)
    params.delete('stripe')
    const qs = params.toString()
    router.replace(qs ? `/become-a-partner?${qs}` : '/become-a-partner')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const infoValid = !!form.firstName && !!form.lastName && !!form.email
    && !!form.phoneNumber && !!form.restaurantName && !!form.zip && !!form.password

  // ── Step 1 → create the FM account (POST /registration), unchanged wiring ──
  async function registerAccount() {
    setError('')
    if (!infoValid) { setError('Please complete all fields.'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/become-a-partner/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: form.firstName, lastName: form.lastName, email: form.email,
          password: form.password, phoneNumber: form.phoneNumber,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Registration failed.'); return }
      try { localStorage.setItem('currentUser', JSON.stringify(data)) } catch {}
      // Create the FM restaurant via the SUPER_ADMIN service account. Best-effort:
      // a failure here must NOT block onboarding — an admin can create it manually.
      await createRestaurant()
      setStep(1)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Create the restaurant right after the account exists. Stores the FM
  // reference (for Stripe Connect) and the 1P slug (for the success URL).
  async function createRestaurant() {
    try {
      const res = await fetch('/api/become-a-partner/create-restaurant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantName: form.restaurantName, email: form.email,
          phoneNumber: form.phoneNumber, firstName: form.firstName,
          lastName: form.lastName, zipcode: form.zip,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.restaurantReference) {
        // Don't block — log and continue; admin can create the restaurant manually.
        console.error('[become-a-partner] create-restaurant failed:', data?.error || res.status)
        return
      }
      setRestaurantRef(data.restaurantReference)
      const slug = data.businessNameWithoutSpaces || form.restaurantName.toLowerCase().replace(/[^a-z0-9]/g, '')
      setRestaurantSlug(slug)
      try { localStorage.setItem('partner_restaurant_ref', data.restaurantReference) } catch {}
    } catch (err) {
      console.error('[become-a-partner] create-restaurant request failed:', err)
    }
  }

  // Send the optional menu PDF to the team for manual import. Best-effort —
  // returns true on success/skip, false on failure (must NOT block onboarding).
  // Same /menu-upload route + Mailgun email to concierge@discocater.com.
  async function sendMenu(): Promise<boolean> {
    if (!menuFile) return true
    try {
      const fd = new FormData()
      fd.append('menuFile', menuFile)
      fd.append('restaurantName', form.restaurantName)
      fd.append('email', form.email)
      const res = await fetch('/api/become-a-partner/menu-upload', { method: 'POST', body: fd })
      const data = await res.json().catch(() => null)
      return !!(res.ok && data?.success)
    } catch {
      return false
    }
  }

  // ── Step 4 → finish onboarding (with or without a menu) ────────────────────
  async function completeOnboarding(skip: boolean) {
    setError('')
    setLoading(true)
    try {
      const menuOk = skip ? true : await sendMenu()
      const res = await fetch('/api/become-a-partner/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Full context for the team notification email. agreedToPricing = the
        // required First Party terms.
        body: JSON.stringify({
          restaurantName: form.restaurantName,
          email: form.email,
          phone: form.phoneNumber,
          zip: form.zip,
          joinedMarketplace,
          stripeConnected,
          agreedToPricing: true,
          agreedToDelivery: false,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error || 'Something went wrong. Please try again.'); return }
      // Surface a menu-upload failure but still advance — never block onboarding.
      if (!menuOk) setError('Menu upload failed — you can email your menu to concierge@discocater.com')
      setStep(5)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Stripe Connect — wiring unchanged ──────────────────────────────────────
  async function connectStripe() {
    setError('')
    // The restaurant reference comes from the create-restaurant step — NOT from
    // currentUser, which is a plain USER account with no restaurantReference.
    let ref = restaurantRef
    let token = ''
    try {
      if (!ref) ref = localStorage.getItem('partner_restaurant_ref') || ''
      const cu = JSON.parse(localStorage.getItem('currentUser') || '{}')
      token = cu.authorization || ''
    } catch {}
    if (!ref) {
      setError('We couldn’t find your restaurant reference. Please contact concierge@discocater.com to finish Stripe setup.')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/become-a-partner/stripe-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
        body: JSON.stringify({ restaurantReference: ref }),
      })
      const data = await res.json()
      if (!res.ok || !data.stripeConnectUrl) {
        setError(data.error || 'Could not initiate Stripe Connect. Please contact concierge@discocater.com.')
        return
      }
      // Persist progress — the Stripe redirect reloads the page on return.
      try { localStorage.setItem('partner_onboarding', JSON.stringify({ form, joinedMarketplace, restaurantRef: ref, restaurantSlug })) } catch {}
      window.location.href = data.stripeConnectUrl
    } catch {
      setError('Could not initiate Stripe Connect. Please contact concierge@discocater.com.')
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
        {step >= 1 && step <= 4 ? (
          <button onClick={back} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#777', fontFamily: F, fontWeight: 600, padding: 0 }}>
            ‹ Back
          </button>
        ) : (
          <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
        )}
        {step <= 4 && (
          <div style={{ fontSize: 13, color: '#aaa', fontWeight: 700 }}>Step {step + 1} of 5</div>
        )}
      </div>

      {/* Logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '16px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#999' }}> cater</span>
        </Link>
      </div>

      {/* Step indicator — five segments */}
      {step <= 4 && (
        <div style={{ maxWidth: 560, width: '100%', margin: '18px auto 0', padding: '0 24px', display: 'flex', gap: 8 }}>
          {[0, 1, 2, 3, 4].map(i => (
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
              <p style={subStyle}>Tell us about you and your restaurant. Signing up is fast, free, and month-to-month — no contract.</p>
              {errorBox}
              <div style={{ marginTop: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="First name" value={form.firstName} onChange={v => set('firstName', v)} autoComplete="given-name" />
                  <Field label="Last name" value={form.lastName} onChange={v => set('lastName', v)} autoComplete="family-name" />
                </div>
                <Field label="Email" value={form.email} onChange={v => set('email', v)} type="email" autoComplete="email" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="Phone" value={form.phoneNumber} onChange={v => set('phoneNumber', v)} type="tel" autoComplete="tel" />
                  <Field label="Zip code" value={form.zip} onChange={v => set('zip', v)} autoComplete="postal-code" />
                </div>
                <Field label="Restaurant name" value={form.restaurantName} onChange={v => set('restaurantName', v)} />
                <Field label="Create a password" value={form.password} onChange={v => set('password', v)} type="password" autoComplete="new-password" />
              </div>
              <button onClick={registerAccount} disabled={!infoValid || loading}
                style={{ ...primaryBtn, marginTop: 8, opacity: (infoValid && !loading) ? 1 : 0.5, cursor: (infoValid && !loading) ? 'pointer' : 'default' }}>
                {loading ? 'Creating your account…' : 'Continue'}
              </button>
            </div>
          )}

          {/* ── STEP 2 · FIRST PARTY (1P) — required ── */}
          {step === 1 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>First Party (Direct Orders)</h1>
              <p style={subStyle}>Orders placed directly through your restaurant portal. No commission — free forever.</p>
              {errorBox}

              {/* 1P pricing */}
              <div style={{ marginTop: 18, border: '1px solid #ececf4', borderRadius: 16, padding: '4px 18px 14px' }}>
                <PriceRow label="Direct Entry orders" detail="Orders you enter yourself through your portal" value="0%" who="restaurant" />
                <PriceRow label="Customer convenience fee" detail="Added at checkout" value="3%" who="customer" />
                <PriceRow label="Stripe processing" detail="Per transaction" value="2.90% + $0.30" who="restaurant" />
              </div>

              {/* Required agreement */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 11, cursor: 'pointer', margin: '20px 0 6px' }}>
                <input type="checkbox" checked={agree1P} onChange={e => setAgree1P(e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>
                  I agree to the{' '}
                  <a href="/terms" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Disco Cater Terms of Service</a>
                  {' '}and{' '}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#5B6FE8' }}>Privacy Policy</a>
                </span>
              </label>
              <p style={{ fontSize: 12, color: '#999', lineHeight: 1.5, margin: '0 0 18px', paddingLeft: 29 }}>
                By checking this box you agree to our{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: BLUE }}>Terms of Service</a>
                {' '}and the pricing above.
              </p>

              <button onClick={() => { setError(''); setStep(2) }} disabled={!agree1P}
                style={{ ...primaryBtn, opacity: agree1P ? 1 : 0.5, cursor: agree1P ? 'pointer' : 'default' }}>
                Continue
              </button>
            </div>
          )}

          {/* ── STEP 3 · MARKETPLACE (3P) — optional ── */}
          {step === 2 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Marketplace (Optional)</h1>
              <p style={{ ...subStyle, fontWeight: 700, color: DARK, margin: '0 0 6px' }}>Get discovered by new customers through the Disco Cater marketplace</p>
              <p style={subStyle}>We send you new catering leads. You only pay when we deliver a new customer.</p>
              {errorBox}

              {/* 3P pricing */}
              <div style={{ marginTop: 18, border: '1px solid #ececf4', borderRadius: 16, padding: '4px 18px 14px' }}>
                <PriceRow label="First-time customers" detail="Of order subtotal — per new customer we bring you" value="15%" who="restaurant" />
                <PriceRow label="Returning customers" detail="Of order subtotal — for repeat orders" value="5%" who="restaurant" />
                <PriceRow label="Third-party delivery" detail="Optional couriers, billed to the customer" value="Paid by customer" who="customer" />
              </div>

              {/* Opt-in agreement (only required to join) */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 11, cursor: 'pointer', margin: '20px 0 6px' }}>
                <input type="checkbox" checked={agreeMarketplace} onChange={e => setAgreeMarketplace(e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>I agree to the Disco Cater Marketplace Terms</span>
              </label>
              <p style={{ fontSize: 12, color: '#999', lineHeight: 1.5, margin: '0 0 18px', paddingLeft: 29 }}>
                Required only if you join the marketplace.
              </p>

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

          {/* ── STEP 4 · CONNECT YOUR BANK (Stripe) ── */}
          {step === 3 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Connect your bank</h1>
              <p style={subStyle}>Connect your bank account with Stripe to receive payouts. You can do this now or anytime from your dashboard.</p>
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

              {/* Continue — banking is optional, so this is always enabled */}
              <button onClick={() => { setError(''); setStep(4) }} disabled={loading}
                style={{ ...primaryBtn, marginTop: 14, background: stripeConnected ? BLUE : '#fff', color: stripeConnected ? '#fff' : BLUE, border: stripeConnected ? 'none' : `1.5px solid ${BLUE}`, opacity: loading ? 0.6 : 1, cursor: loading ? 'default' : 'pointer' }}>
                {stripeConnected ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          )}

          {/* ── STEP 5 · UPLOAD YOUR MENU ── */}
          {step === 4 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Upload your menu</h1>
              <p style={subStyle}>Upload a PDF of your current catering menu. Our team will set it up in your portal within 1 business day.</p>
              {errorBox}

              {/* Menu upload */}
              <div style={{ marginTop: 18 }}>
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

              {/* Finish */}
              <button onClick={() => completeOnboarding(false)} disabled={loading}
                style={{ ...primaryBtn, marginTop: 24, opacity: loading ? 0.6 : 1, cursor: loading ? 'default' : 'pointer' }}>
                {loading ? (menuFile ? 'Uploading menu…' : 'Finishing up…') : 'Complete setup'}
              </button>

              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => completeOnboarding(true)} disabled={loading}
                  style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontWeight: 600, fontFamily: F, cursor: loading ? 'default' : 'pointer', textDecoration: 'underline' }}>
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {/* ── SUCCESS ── */}
          {step === 5 && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 30px' }}>
              <h1 style={{ ...h1Style, fontSize: 28 }}>You&apos;re all set! 🎉</h1>
              <p style={{ ...subStyle, maxWidth: 420, margin: '0 auto 8px' }}>
                Our team will be in touch within 1 business day to complete your setup.
              </p>
              {error && (
                <div style={{ background: '#fff3f3', border: '1px solid #ffd6d6', color: '#c0392b', borderRadius: 12, padding: '10px 14px', fontSize: 13, maxWidth: 420, margin: '14px auto 0', textAlign: 'left' }}>
                  {error}
                </div>
              )}

              {/* Dashboard login. NOTE: target is /restaurant/login, not bare
                  /restaurant (no index route — it would 404). Once auto-login is
                  wired (deferred), point this at the role's landing page. */}
              <a href="/restaurant/login"
                style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', textDecoration: 'none', marginTop: 24 }}>
                Log in to dashboard →
              </a>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
