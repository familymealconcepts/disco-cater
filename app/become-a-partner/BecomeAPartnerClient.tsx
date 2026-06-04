'use client'
import { useState } from 'react'
import Link from 'next/link'

// ── Brand ────────────────────────────────────────────────────────────────────
const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'
const CHARCOAL = '#2a2a2a'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

// ── Shared styles ────────────────────────────────────────────────────────────
const pillInput: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 999, border: '1.5px solid #e6e6ee',
  padding: '0 20px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none',
  background: '#fff', boxSizing: 'border-box',
}
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6, display: 'block' }
const primaryBtn: React.CSSProperties = {
  width: '100%', height: 50, borderRadius: 999, border: 'none', background: BLUE,
  color: '#fff', fontSize: 15, fontWeight: 700, fontFamily: F, cursor: 'pointer',
  transition: 'opacity 0.15s, background 0.15s',
}
const secondaryBtn: React.CSSProperties = {
  width: '100%', height: 50, borderRadius: 999, border: 'none', background: CHARCOAL,
  color: '#fff', fontSize: 15, fontWeight: 700, fontFamily: F, cursor: 'pointer',
}
const h1Style: React.CSSProperties = { fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.02em', lineHeight: 1.2 }
const subStyle: React.CSSProperties = { fontSize: 14, color: '#585786', lineHeight: 1.6, margin: '0 0 8px' }
const italicNote: React.CSSProperties = { fontSize: 13, color: '#888', fontStyle: 'italic', lineHeight: 1.6, margin: '0 0 8px' }

interface FormState {
  firstName: string; lastName: string; email: string; phoneNumber: string
  restaurantName: string; zip: string; confirmEmail: string; password: string
}

// Small field helper — pill input with a label.
function Field({ label: lbl, value, onChange, type = 'text', placeholder, autoComplete }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; autoComplete?: string
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={label}>{lbl}</label>
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

// Checkbox row.
function Check({ checked, onChange, children }: { checked: boolean; onChange: (b: boolean) => void; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '6px 0 18px' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
      <span style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>{children}</span>
    </label>
  )
}

export default function BecomeAPartnerClient() {
  const [step, setStep] = useState(0) // 0–4, then 5 = success
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', email: '', phoneNumber: '',
    restaurantName: '', zip: '', confirmEmail: '', password: '',
  })
  const [agreePrivacy, setAgreePrivacy] = useState(false)
  const [agreeDelivery, setAgreeDelivery] = useState(false)
  const [agreePricing, setAgreePricing] = useState(false)
  // Step 4 — optional catering menu the diner can share for our team to import.
  const [menuUrl, setMenuUrl] = useState('')
  const [menuFile, setMenuFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: keyof FormState, v: string) => setForm(p => ({ ...p, [k]: v }))

  // Step 1 → prefill confirm email from step 0 email the first time we land here.
  function goToStep1() {
    setError('')
    setForm(p => ({ ...p, confirmEmail: p.confirmEmail || p.email }))
    setStep(1)
  }

  const step0Valid = !!form.firstName && !!form.lastName && !!form.email && !!form.phoneNumber && !!form.restaurantName && !!form.zip

  // ── Step 1: create account (register) ──────────────────────────────────────
  async function registerAccount() {
    setError('')
    if (!form.firstName || !form.lastName || !form.email || !form.password) {
      setError('Please complete all fields.'); return
    }
    if (form.email.trim().toLowerCase() !== form.confirmEmail.trim().toLowerCase()) {
      setError('Email addresses do not match.'); return
    }
    if (!agreePrivacy) { setError("Please agree to Disco Cater's Privacy Policy and Merchant Agreement."); return }
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
      setStep(2)
    } catch {
      setError('Unable to connect. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const hasMenu = !!(menuUrl.trim() || menuFile)

  // Send the optional menu to the team for manual import. Best-effort — returns
  // true on success/skip, false on failure (which must NOT block onboarding).
  async function sendMenu(): Promise<boolean> {
    if (!hasMenu) return true
    try {
      let res: Response
      if (menuFile) {
        const fd = new FormData()
        if (menuUrl.trim()) fd.append('menuUrl', menuUrl.trim())
        fd.append('menuFile', menuFile)
        fd.append('restaurantName', form.restaurantName)
        fd.append('email', form.email)
        res = await fetch('/api/become-a-partner/menu-upload', { method: 'POST', body: fd })
      } else {
        res = await fetch('/api/become-a-partner/menu-upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ menuUrl: menuUrl.trim(), restaurantName: form.restaurantName, email: form.email }),
        })
      }
      const data = await res.json().catch(() => null)
      return !!(res.ok && data?.success)
    } catch {
      return false
    }
  }

  // ── Step 4: complete onboarding ────────────────────────────────────────────
  async function completeOnboarding() {
    setError('')
    if (!agreePricing) { setError('Please agree to the Merchant Order Form to continue.'); return }
    setLoading(true)
    try {
      // 1. Send the menu (if provided) — failure is non-blocking.
      const menuOk = await sendMenu()
      // 2. Complete onboarding as normal.
      const res = await fetch('/api/become-a-partner/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, agreedToPricing: true, agreedToDelivery: agreeDelivery }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error || 'Something went wrong. Please try again.'); return }
      // 3. Surface a menu-upload failure but still advance — don't block onboarding.
      if (!menuOk) setError('Menu upload failed — you can email your menu to concierge@discocater.com')
      setStep(5)
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
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); * { box-sizing: border-box; }`}</style>

      {/* Top bar: back link (left) + step indicator (right) */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '22px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 40 }}>
        <div>
          {step >= 1 && step <= 4 ? (
            <button onClick={back} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#777', fontFamily: F, fontWeight: 600, padding: 0 }}>
              ‹ Back
            </button>
          ) : (
            <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
          )}
        </div>
        {step >= 1 && step <= 4 && (
          <div style={{ fontSize: 13, color: '#aaa', fontWeight: 600 }}>Step {step} of 4</div>
        )}
      </div>

      {/* Logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '18px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#999' }}> cater</span>
        </Link>
      </div>

      {/* Form card */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '28px 24px 60px' }}>
        <div style={{ width: '100%', maxWidth: 500 }}>

          {/* ── STEP 0 ── */}
          {step === 0 && (
            <>
              <h1 style={h1Style}>Welcome to Disco Cater! Let&apos;s get started.</h1>
              <p style={subStyle}>Please complete this form to create your restaurant account.</p>
              <div style={{ marginTop: 22 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="First Name" value={form.firstName} onChange={v => set('firstName', v)} autoComplete="given-name" />
                  <Field label="Last Name" value={form.lastName} onChange={v => set('lastName', v)} autoComplete="family-name" />
                </div>
                <Field label="Email" value={form.email} onChange={v => set('email', v)} type="email" autoComplete="email" />
                <Field label="Phone Number" value={form.phoneNumber} onChange={v => set('phoneNumber', v)} type="tel" autoComplete="tel" />
                <Field label="Restaurant Name" value={form.restaurantName} onChange={v => set('restaurantName', v)} />
                <Field label="Zip Code" value={form.zip} onChange={v => set('zip', v)} autoComplete="postal-code" />
              </div>
              <button onClick={goToStep1} disabled={!step0Valid}
                style={{ ...primaryBtn, marginTop: 8, opacity: step0Valid ? 1 : 0.5, cursor: step0Valid ? 'pointer' : 'default' }}>
                Continue
              </button>
            </>
          )}

          {/* ── STEP 1 ── */}
          {step === 1 && (
            <>
              <h1 style={h1Style}>Let&apos;s create your account.</h1>
              <p style={subStyle}>Signing up for Disco Cater is fast and free. No commitment or contract.</p>
              <p style={italicNote}>You can edit or update your account information at any time.</p>
              <div style={{ marginTop: 18 }}>
                {errorBox}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Field label="First Name" value={form.firstName} onChange={v => set('firstName', v)} autoComplete="given-name" />
                  <Field label="Last Name" value={form.lastName} onChange={v => set('lastName', v)} autoComplete="family-name" />
                </div>
                <Field label="Email" value={form.email} onChange={v => set('email', v)} type="email" autoComplete="email" />
                <Field label="Confirm Email" value={form.confirmEmail} onChange={v => set('confirmEmail', v)} type="email" />
                <Field label="Password" value={form.password} onChange={v => set('password', v)} type="password" autoComplete="new-password" />
                <Check checked={agreePrivacy} onChange={setAgreePrivacy}>
                  I agree to Disco Cater&apos;s Privacy Policy and Merchant Agreement.
                </Check>
              </div>
              <button onClick={registerAccount} disabled={loading}
                style={{ ...primaryBtn, opacity: loading ? 0.7 : 1, cursor: loading ? 'default' : 'pointer' }}>
                {loading ? 'Creating your account…' : 'Continue'}
              </button>
            </>
          )}

          {/* ── STEP 2 ── */}
          {step === 2 && (
            <>
              <h1 style={h1Style}>Time to get you paid.</h1>
              <p style={subStyle}>
                Connect to our payment processor, Stripe. By connecting your account, you are agreeing
                to the terms and processing fees (2.90% + $0.30) of Stripe.
              </p>
              <div style={{ marginTop: 22 }}>
                <a href="#"
                  style={{ ...primaryBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}>
                  Connect to <span style={{ fontWeight: 800, fontStyle: 'italic' }}>Stripe</span> →
                </a>
              </div>
              <p style={{ ...italicNote, marginTop: 18 }}>
                Estimated time to complete – 15min. Please have the following information ready:
                Business Tax ID and/or Social Security Number, Bank Routing Number &amp; Bank Account Number.
              </p>
              <button onClick={() => { setError(''); setStep(3) }} style={{ ...secondaryBtn, marginTop: 10 }}>
                Not now, let&apos;s keep going
              </button>
              <p style={{ ...italicNote, marginTop: 16, fontSize: 12, color: '#999' }}>
                Note: Stripe Connect integration is coming soon. Contact concierge@discocater.com to get set up.
              </p>
            </>
          )}

          {/* ── STEP 3 ── */}
          {step === 3 && (
            <>
              <h1 style={h1Style}>Interested in third-party delivery?</h1>
              <p style={subStyle}>
                Disco Cater provides immediate access to local couriers that can be automatically
                dispatched when your customer chooses Delivery.
              </p>
              <p style={italicNote}>
                Disco Cater&apos;s customer delivery fee is 15% of the subtotal with the option to
                subsidize in your Order Settings.
              </p>
              <div style={{ marginTop: 18 }}>
                <Check checked={agreeDelivery} onChange={setAgreeDelivery}>
                  I agree to Disco Cater&apos;s Third-Party Delivery Policy.
                </Check>
              </div>
              <button onClick={() => { setError(''); setStep(4) }} disabled={!agreeDelivery}
                style={{ ...primaryBtn, marginBottom: 10, opacity: agreeDelivery ? 1 : 0.5, cursor: agreeDelivery ? 'pointer' : 'default' }}>
                Continue
              </button>
              <button onClick={() => { setError(''); setStep(4) }} style={secondaryBtn}>
                Not now, let&apos;s keep going
              </button>
            </>
          )}

          {/* ── STEP 4 ── */}
          {step === 4 && (
            <>
              <h1 style={h1Style}>Review your pricing agreement.</h1>
              <p style={subStyle}>Before we get started, please review and accept the Disco Cater Merchant Order Form.</p>

              {errorBox}

              {/* Fee table */}
              <div style={{ border: '1px solid #eee', borderRadius: 14, overflow: 'hidden', margin: '18px 0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: DARK }}>
                      {['Fee Type', 'Description', 'Paid By', 'Rate'].map(h => (
                        <th key={h} style={{ color: '#fff', textAlign: 'left', padding: '10px 12px', fontWeight: 700, fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Lead Gen 1', '1st unique customer order per account (determined by email address)', 'Merchant', '15.00%*'],
                      ['Lead Gen 2', 'Ongoing fee for returning customer at a unique merchant location', 'Merchant', '5.00%*'],
                      ['Disco Cater Convenience Fee', 'Convenience fee collected at customer checkout', 'Customer', '3.00%*'],
                      ['Third-Party Delivery', 'Optional fee for third-party delivery orders', 'Customer', '15.00%* (max $85.00)'],
                      ['Credit Card Processing', 'Card-Not-Present transactions via Stripe', 'Merchant', '2.90% + $0.30**'],
                    ].map((row, i) => (
                      <tr key={row[0]} style={{ borderTop: '1px solid #f0f0f0', background: i % 2 ? '#fafafb' : '#fff' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 700, color: DARK, verticalAlign: 'top' }}>{row[0]}</td>
                        <td style={{ padding: '10px 12px', color: '#666', verticalAlign: 'top', lineHeight: 1.45 }}>{row[1]}</td>
                        <td style={{ padding: '10px 12px', color: '#666', verticalAlign: 'top' }}>{row[2]}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 700, color: BLUE, verticalAlign: 'top', whiteSpace: 'nowrap' }}>{row[3]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: '#999', margin: '0 0 18px', lineHeight: 1.6 }}>
                *Calculated on order subtotal. &nbsp; **Calculated on order total.
              </p>

              {/* Subscription */}
              <div style={{ border: '1px solid #eee', borderRadius: 14, overflow: 'hidden', marginBottom: 18 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: DARK }}>
                      {['Service', 'Paid By', 'Monthly Cost'].map(h => (
                        <th key={h} style={{ color: '#fff', textAlign: 'left', padding: '10px 12px', fontWeight: 700, fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: '10px 12px', color: '#666', verticalAlign: 'top', lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 700, color: DARK }}>Disco Cater Platform</span> — Full access to the catering platform, including customer and sales data
                      </td>
                      <td style={{ padding: '10px 12px', color: '#666', verticalAlign: 'top' }}>Merchant</td>
                      <td style={{ padding: '10px 12px', fontWeight: 700, color: BLUE, verticalAlign: 'top' }}>$0</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Contract terms */}
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: DARK, marginBottom: 8 }}>Contract Terms</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: '#666', lineHeight: 1.6 }}>
                  <li style={{ marginBottom: 6 }}><strong>Start Date:</strong> The date you complete onboarding and check the acceptance box below (the &quot;Effective Date&quot;).</li>
                  <li style={{ marginBottom: 6 }}><strong>Initial Term:</strong> Month-to-month (no minimum commitment).</li>
                  <li><strong>Pricing Lock:</strong> All fees listed above are fixed and will not increase without at least 30 days&apos; prior written notice and your express written consent.</li>
                </ul>
              </div>

              <Check checked={agreePricing} onChange={setAgreePricing}>
                I agree to the Disco Cater Merchant Order Form and Merchant Agreement Terms and Conditions.
              </Check>

              {/* Optional menu upload — sent to the team for manual import. */}
              <div style={{ borderTop: '1px solid #eee', paddingTop: 18, marginTop: 6, marginBottom: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: DARK, margin: '0 0 6px' }}>Share your catering menu</div>
                <p style={subStyle}>
                  Optional: share your catering menu and our team will build it for you in FamilyMeal. You can also
                  skip this step and send your menu to concierge@discocater.com later.
                </p>
                <div style={{ marginTop: 14 }}>
                  <label style={label}>Menu link</label>
                  <input value={menuUrl} onChange={e => setMenuUrl(e.target.value)}
                    placeholder="Link to your online menu (ezCater, website, Google Drive…)"
                    style={pillInput} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={label}>Or upload a file</label>
                  <input type="file"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={e => setMenuFile(e.target.files?.[0] || null)}
                    style={{ display: 'block', fontSize: 13, fontFamily: F, marginTop: 4 }} />
                </div>
                <p style={{ fontSize: 12, color: '#999', fontStyle: 'italic', lineHeight: 1.5, margin: '10px 0 0' }}>
                  Accepted formats: PDF, DOC, DOCX, or a link to your online menu (ezCater, website, Google Drive, etc.)
                </p>
              </div>

              <button onClick={completeOnboarding} disabled={loading || !agreePricing}
                style={{ ...primaryBtn, marginTop: 8, opacity: (loading || !agreePricing) ? 0.5 : 1, cursor: (loading || !agreePricing) ? 'default' : 'pointer' }}>
                {loading ? (hasMenu ? 'Uploading menu…' : 'Creating account…') : 'Create account'}
              </button>
            </>
          )}

          {/* ── SUCCESS ── */}
          {step === 5 && (
            <div style={{ textAlign: 'center', paddingTop: 24 }}>
              <h1 style={{ ...h1Style, fontSize: 28 }}>You&apos;re ready to get started. 🪩</h1>
              <p style={{ ...subStyle, maxWidth: 420, margin: '0 auto 28px' }}>
                Your Disco Cater account has been created. A Disco Cater team member will be in touch
                shortly to help you go live.
              </p>
              {error && (
                <div style={{ background: '#fff3f3', border: '1px solid #ffd6d6', color: '#c0392b', borderRadius: 12, padding: '10px 14px', fontSize: 13, maxWidth: 420, margin: '0 auto 24px', textAlign: 'left' }}>
                  {error}
                </div>
              )}
              <a href="https://www.familymeal.com"
                style={{ ...primaryBtn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'auto', padding: '0 28px', textDecoration: 'none' }}>
                Go to your dashboard →
              </a>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
