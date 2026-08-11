'use client'
import { useState } from 'react'
import Link from 'next/link'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export default function RestaurantForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  async function submit() {
    if (!email.trim() || submitting) return
    setSubmitting(true)
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
    } catch { /* uniform success regardless — anti-enumeration, matches the API */ }
    setSubmitting(false)
    setDone(true)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8FC', fontFamily: F, padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '32px 36px', maxWidth: 420, width: '100%', boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>
        <div style={{ marginBottom: 24 }}>
          <span style={{ fontSize: 22, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: '#999' }}> cater</span>
        </div>

        {done ? (
          <div style={{ fontSize: 14, color: '#555', lineHeight: 1.6 }}>
            If an account exists for that email, check your inbox for instructions to finish resetting your
            password.
            {/* This same form serves both Disco-native accounts (emailed a reset LINK, expires in 1h) and
                legacy FM-backed accounts (emailed a TEMPORARY PASSWORD instead) — the API responds
                uniformly for both to avoid leaking which kind of account exists, so this copy can't be
                more specific. The secondary link below is for whoever got a temporary password. */}
            <div style={{ marginTop: 14 }}>
              Got a temporary password instead of a link?{' '}
              <Link href="/reset-password" style={{ color: INDIGO, fontWeight: 600 }}>Enter it here</Link>.
            </div>
          </div>
        ) : (
          <>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: DARK, margin: '0 0 4px' }}>Reset your password</h1>
            <p style={{ fontSize: 14, color: '#888', margin: '0 0 22px' }}>We&apos;ll email you instructions to set a new one.</p>

            <label style={lbl}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@restaurant.com"
              style={input} onKeyDown={e => { if (e.key === 'Enter') submit() }} />

            <button onClick={submit} disabled={submitting}
              style={{ width: '100%', marginTop: 20, padding: '12px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: submitting ? 'default' : 'pointer', fontFamily: F, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Sending…' : 'Send reset instructions'}
            </button>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <Link href="/restaurant/login" style={{ fontSize: 13, color: INDIGO, fontWeight: 600, textDecoration: 'none' }}>Back to log in</Link>
        </div>
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
const input: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '10px 12px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
