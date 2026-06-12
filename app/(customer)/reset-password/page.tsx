'use client'

import { useState, useEffect, type CSSProperties } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Pre-fill the email from a ?email= link param (FM may include it). Read from
  // window so we don't need a Suspense boundary for useSearchParams.
  useEffect(() => {
    try {
      const e = new URLSearchParams(window.location.search).get('email')
      if (e) setEmail(e)
    } catch { /* noop */ }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!email || !temporaryPassword || !newPassword || !confirmPassword) {
      setError('Please fill in all fields.'); return
    }
    if (newPassword.length < 8) {
      setError('Your new password must be at least 8 characters.'); return
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.'); return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, temporaryPassword, newPassword }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Could not reset your password. Please try again.')
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', fontFamily: F, background: 'linear-gradient(180deg,rgba(107,110,249,0.05) 0%,rgba(240,70,138,0.02) 100%),#fff', display: 'flex', flexDirection: 'column' }}>
      {/* Header — logo only, no nav. */}
      <header style={{ display: 'flex', alignItems: 'center', padding: '9px 18px', borderBottom: '1px solid #f0f0f0', background: 'linear-gradient(180deg,rgba(107,110,249,0.07) 0%,rgba(240,70,138,0.03) 100%),#fff' }}>
        <Link href="/" style={{ textDecoration: 'none' }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.3px' }}>
            <span style={{ background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
            <span style={{ color: '#999' }}> cater</span>
          </span>
        </Link>
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px' }}>
        <div style={{ width: '100%', maxWidth: 420, background: '#fff', border: '1px solid #f0f0f0', borderRadius: 16, padding: '28px 26px', boxShadow: '0 8px 30px rgba(26,16,40,0.06)' }}>
          {done ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 14 }}>✅</div>
              <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 10px' }}>Password updated</h1>
              <p style={{ fontSize: 14, color: '#555', lineHeight: 1.55, margin: '0 0 22px' }}>
                You can now log in with your new password.
              </p>
              <Link href="/?login=true" style={{ display: 'block', width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 999, cursor: 'pointer', fontFamily: F, textDecoration: 'none', textAlign: 'center', boxSizing: 'border-box' }}>
                Log In
              </Link>
            </div>
          ) : (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 6px', letterSpacing: '-0.02em' }}>Reset your password</h1>
              <p style={{ fontSize: 13, color: '#888', lineHeight: 1.5, margin: '0 0 20px' }}>
                Enter the temporary password from your email, then choose a new one.
              </p>

              <form onSubmit={handleSubmit}>
                <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" />
                <Field label="Temporary password" type="password" value={temporaryPassword} onChange={setTemporaryPassword} autoComplete="one-time-code" placeholder="From your email" />
                <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" placeholder="At least 8 characters" />
                <Field label="Confirm new password" type="password" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" placeholder="Re-enter new password" />

                {error && (
                  <div style={{ background: 'rgba(231,111,81,0.1)', color: '#C0392B', fontSize: 13, lineHeight: 1.4, padding: '10px 12px', borderRadius: 10, marginBottom: 14 }}>
                    {error}
                  </div>
                )}

                <button type="submit" disabled={loading}
                  style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 999, cursor: loading ? 'default' : 'pointer', fontFamily: F, opacity: loading ? 0.6 : 1 }}>
                  {loading ? 'Updating…' : 'Update password'}
                </button>
              </form>

              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <Link href="/?login=true" style={{ fontSize: 13, color: BLUE, fontWeight: 600, textDecoration: 'none' }}>Back to log in</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, type, value, onChange, placeholder, autoComplete }: {
  label: string; type: string; value: string; onChange: (v: string) => void; placeholder?: string; autoComplete?: string
}) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#777', marginBottom: 6 }}>{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  )
}

const inputStyle: CSSProperties = {
  width: '100%', padding: '11px 13px', border: '1px solid #e0e0e0', borderRadius: 10,
  fontSize: 14, fontFamily: F, outline: 'none', boxSizing: 'border-box', color: DARK,
}
