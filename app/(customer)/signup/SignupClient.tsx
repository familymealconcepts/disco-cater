'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuthContext } from '../../context/AuthContext'

const F = "'DM Sans', sans-serif"
const BLUE = '#586CE1'
const DARK = '#1A1028'
const GRADIENT = 'linear-gradient(90deg, #6466E8 0%, #C044C8 50%, #F0468A 100%)'

const pillInput: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 999, border: '1.5px solid #e6e6ee',
  padding: '0 20px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none',
  background: '#fff', boxSizing: 'border-box',
}
const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6, display: 'block' }

// name + autoComplete are REQUIRED, not optional — a plain input with neither
// is exactly what let a browser drop an autofilled email into a phone field
// elsewhere in the app (confirmed live), and phone/email sit right next to
// each other in this same form. Required here means a future field added to
// this page can't silently omit them.
function Field({ label, value, onChange, name, autoComplete, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; name: string; autoComplete: string; type?: string; placeholder?: string
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelSt}>{label}</label>
      <input
        type={type} name={name} value={value} autoComplete={autoComplete} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onFocus={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(91,111,232,0.12)' }}
        onBlur={e => { e.currentTarget.style.borderColor = '#e6e6ee'; e.currentTarget.style.boxShadow = 'none' }}
        style={pillInput}
      />
    </div>
  )
}

export default function SignupClient() {
  const router = useRouter()
  const { register } = useAuthContext()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [confirmEmail, setConfirmEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agree, setAgree] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setError('')
    if (!firstName || !lastName || !email || !password) { setError('Please complete all fields.'); return }
    // Phone is optional — submitting without one succeeds.
    if (email.trim().toLowerCase() !== confirmEmail.trim().toLowerCase()) { setError('Email addresses do not match.'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (!agree) { setError("Please agree to Disco Cater's Privacy Policy and Terms of Service."); return }
    setLoading(true)
    try {
      // Use the shared auth context so the new account is auto-logged-in
      // (sets the user + disco_user + header) — no second login needed.
      await register({ email, password, firstName, lastName, phoneNumber: phone || undefined })
      router.push('/account/orders')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Sign up failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100svh', background: '#fff', fontFamily: F, display: 'flex', flexDirection: 'column' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); * { box-sizing: border-box; }`}</style>

      {/* Top bar: back link + logo */}
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '22px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link href="/" style={{ fontSize: 14, color: '#777', textDecoration: 'none', fontWeight: 600 }}>‹ Back</Link>
      </div>
      <div style={{ maxWidth: 560, width: '100%', margin: '0 auto', padding: '18px 24px 0', textAlign: 'center' }}>
        <Link href="/" style={{ textDecoration: 'none', fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>
          <span style={{ background: GRADIENT, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
          <span style={{ color: '#727272' }}> cater</span>
        </Link>
      </div>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '28px 24px 60px' }}>
        <div style={{ width: '100%', maxWidth: 460 }}>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: DARK, margin: '0 0 10px', letterSpacing: '-0.02em' }}>Create your account.</h1>
          <p style={{ fontSize: 14, color: '#585786', lineHeight: 1.6, margin: '0 0 22px' }}>Signing up for Disco Cater is fast and free.</p>

          {error && (
            <div style={{ background: '#fff3f3', border: '1px solid #ffd6d6', color: '#c0392b', borderRadius: 12, padding: '10px 14px', fontSize: 13, margin: '0 0 14px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="First Name" value={firstName} onChange={setFirstName} name="signup-first-name" autoComplete="given-name" />
            <Field label="Last Name" value={lastName} onChange={setLastName} name="signup-last-name" autoComplete="family-name" />
          </div>
          <Field label="Phone Number (optional)" value={phone} onChange={setPhone} name="signup-phone" type="tel" autoComplete="tel" placeholder="e.g. (555) 555-5555" />
          <Field label="Email" value={email} onChange={setEmail} name="signup-email" type="email" autoComplete="email" />
          <Field label="Confirm Email" value={confirmEmail} onChange={setConfirmEmail} name="signup-confirm-email" type="email" autoComplete="email" />
          <Field label="Password" value={password} onChange={setPassword} name="signup-password" type="password" autoComplete="new-password" />

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '6px 0 18px' }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}
              style={{ width: 18, height: 18, marginTop: 1, accentColor: BLUE, cursor: 'pointer', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>
              I agree to Disco Cater&apos;s Privacy Policy and Terms of Service.
            </span>
          </label>

          <button onClick={submit} disabled={loading}
            style={{ width: '100%', height: 50, borderRadius: 999, border: 'none', background: BLUE, color: '#fff', fontSize: 15, fontWeight: 700, fontFamily: F, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Creating your account…' : 'Create account'}
          </button>

          <p style={{ textAlign: 'center', fontSize: 13, color: '#727272', margin: '16px 0 0' }}>
            Already have an account?{' '}
            <Link href="/" style={{ color: BLUE, fontWeight: 700, textDecoration: 'none' }}>Log in</Link>
          </p>
          <p style={{ textAlign: 'center', fontSize: 13, color: '#727272', margin: '8px 0 0' }}>
            Forgot your password?{' '}
            <Link href="/" style={{ color: BLUE, fontWeight: 700, textDecoration: 'none' }}>Reset it →</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
