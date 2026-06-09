'use client'
import { useState } from 'react'
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
  // 0 = your info, 1 = first party (1P), 2 = marketplace (3P, optional),
  // 3 = menu + banking, 4 = success.
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', email: '', phoneNumber: '',
    restaurantName: '', zip: '', password: '',
  })
  const [agree1P, setAgree1P] = useState(false)          // required (step 2)
  const [agreeMarketplace, setAgreeMarketplace] = useState(false) // opt-in (step 3)
  const [joinedMarketplace, setJoinedMarketplace] = useState(false)
  const [menuFile, setMenuFile] = useState<File | null>(null)
  const [menuSkipped, setMenuSkipped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof FormState, v: string) => setForm(p => ({ ...p, [k]: v }))

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
      setStep(1)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
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
        // agreedToPricing = the required First Party terms. joinedMarketplace is
        // extra context the route safely ignores (unchanged contract).
        body: JSON.stringify({ email: form.email, agreedToPricing: true, agreedToDelivery: false, joinedMarketplace }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error || 'Something went wrong. Please try again.'); return }
      if (skip || !menuFile) setMenuSkipped(true)
      // Surface a menu-upload failure but still advance — never block onboarding.
      if (!menuOk) setError('Menu upload failed — you can email your menu to concierge@discocater.com')
      setStep(4)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Stripe Connect — wiring unchanged ──────────────────────────────────────
  async function connectStripe() {
    setError('')
    let ref = ''
    let token = ''
    try {
      const cu = JSON.parse(localStorage.getItem('currentUser') || '{}')
      // FM /registration returns the new account's `reference`; accept the other
      // likely field names too in case the response differs.
      ref = cu.restaurantReference || cu.reference || cu.locationReference || ''
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
        {step >= 1 && step <= 3 ? (
          <button onClick={back} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#777', fontFamily: F, fontWeight: 600, padding: 0 }}>
            ‹ Back
          </button>
        ) : (
          <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
        )}
        {step <= 3 && (
          <div style={{ fontSize: 13, color: '#aaa', fontWeight: 700 }}>Step {step + 1} of 4</div>
        )}
      </div>

      {/* Logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '16px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#999' }}> cater</span>
        </Link>
      </div>

      {/* Step indicator — four segments */}
      {step <= 3 && (
        <div style={{ maxWidth: 560, width: '100%', margin: '18px auto 0', padding: '0 24px', display: 'flex', gap: 8 }}>
          {[0, 1, 2, 3].map(i => (
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
                <span style={{ fontSize: 14, color: DARK, fontWeight: 600, lineHeight: 1.5 }}>I agree to the Disco Cater First Party Terms</span>
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

          {/* ── STEP 4 · MENU + BANKING ── */}
          {step === 3 && (
            <div style={cardStyle}>
              <h1 style={h1Style}>Menu &amp; banking</h1>
              <p style={subStyle}>Two quick things and you&apos;re done.</p>
              {errorBox}

              {/* Menu upload */}
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 4 }}>First, upload your catering menu</div>
                <p style={{ ...subStyle, fontSize: 13 }}>Upload a PDF of your current catering menu. Our team will set it up in your portal within 1 business day.</p>

                <label style={{
                  display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, padding: '14px 16px',
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

              {/* Banking */}
              <div style={{ borderTop: '1px solid #eee', paddingTop: 22, marginTop: 24 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: DARK, marginBottom: 4 }}>Then, connect your bank account to receive payouts</div>
                <p style={{ ...subStyle, fontSize: 13 }}>Powered by Stripe. You can complete this now or anytime from your dashboard.</p>
                <button onClick={connectStripe} disabled={loading}
                  style={{ ...primaryBtn, marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
                  {loading ? 'Connecting…' : <>Connect to <span style={{ fontWeight: 800, fontStyle: 'italic' }}>Stripe</span> →</>}
                </button>
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
          {step === 4 && (
            <div style={{ ...cardStyle, textAlign: 'center', padding: '40px 30px' }}>
              <h1 style={{ ...h1Style, fontSize: 28 }}>You&apos;re all set! 🎉</h1>
              <p style={{ ...subStyle, maxWidth: 420, margin: '0 auto 8px' }}>
                Our team will be in touch within 1 business day to complete your setup.
              </p>
              {!joinedMarketplace && (
                <p style={{ fontSize: 13, color: '#888', maxWidth: 420, margin: '0 auto 8px', lineHeight: 1.6 }}>
                  You can join the marketplace later from your restaurant portal.
                </p>
              )}
              {menuSkipped && (
                <p style={{ fontSize: 13, color: '#888', maxWidth: 420, margin: '0 auto 8px', lineHeight: 1.6 }}>
                  You can send your menu to concierge@discocater.com at any time.
                </p>
              )}
              {error && (
                <div style={{ background: '#fff3f3', border: '1px solid #ffd6d6', color: '#c0392b', borderRadius: 12, padding: '10px 14px', fontSize: 13, maxWidth: 420, margin: '14px auto 0', textAlign: 'left' }}>
                  {error}
                </div>
              )}
              <a href="https://www.familymeal.com"
                style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', textDecoration: 'none', marginTop: 24 }}>
                Go to your dashboard →
              </a>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
