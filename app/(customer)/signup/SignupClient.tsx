'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const BLUE = '#5B6FE8'
const DARK = '#1A1028'
const GRADIENT = 'linear-gradient(90deg, #6B6EF9 0%, #C044C8 50%, #F0468A 100%)'

const pillInput: React.CSSProperties = {
  width: '100%', height: 48, borderRadius: 999, border: '1.5px solid #e6e6ee',
  padding: '0 20px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none',
  background: '#fff', boxSizing: 'border-box',
}
const labelSt: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6, display: 'block' }

function Field({ label, value, onChange, type = 'text', autoComplete, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete?: string; placeholder?: string
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelSt}>{label}</label>
      <input
        type={type} value={value} autoComplete={autoComplete} placeholder={placeholder}
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
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, phoneNumber: phone, email, password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Sign up failed.'); return }
      // Persist as currentUser (same shape login stores) and notify the header.
      try { localStorage.setItem('currentUser', JSON.stringify(data)) } catch {}
      try { window.dispatchEvent(new CustomEvent('disco-user-changed')) } catch {}
      router.push('/account/orders')
    } catch {
      setError('Unable to connect. Please try again.')
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
          <span style={{ color: '#999' }}> cater</span>
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
            <Field label="First Name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
            <Field label="Last Name" value={lastName} onChange={setLastName} autoComplete="family-name" />
          </div>
          <Field label="Phone Number (optional)" value={phone} onChange={setPhone} type="tel" autoComplete="tel" placeholder="e.g. (555) 555-5555" />
          <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" />
          <Field label="Confirm Email" value={confirmEmail} onChange={setConfirmEmail} type="email" />
          <Field label="Password" value={password} onChange={setPassword} type="password" autoComplete="new-password" />

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

          <p style={{ textAlign: 'center', fontSize: 13, color: '#888', margin: '16px 0 0' }}>
            Already have an account?{' '}
            <Link href="/" style={{ color: BLUE, fontWeight: 700, textDecoration: 'none' }}>Log in</Link>
          </p>
          <p style={{ textAlign: 'center', fontSize: 13, color: '#888', margin: '8px 0 0' }}>
            Forgot your password?{' '}
            <Link href="/" style={{ color: BLUE, fontWeight: 700, textDecoration: 'none' }}>Reset it →</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
