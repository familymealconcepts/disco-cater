'use client'
import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

interface InviteInfo { valid: boolean; email?: string; firstName?: string; restaurantName?: string }

function AcceptInviteInner() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params.get('token') || ''

  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!token) { setInfo({ valid: false }); setLoading(false); return }
    let cancelled = false
    fetch(`/api/restaurant/accept-invite?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setInfo(d) })
      .catch(() => { if (!cancelled) setInfo({ valid: false }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  async function submit() {
    setError('')
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    setSubmitting(true)
    const res = await fetch('/api/restaurant/accept-invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    })
    const d = await res.json().catch(() => ({}))
    setSubmitting(false)
    if (res.ok && d?.success) {
      // Mirror the login page so the portal layout shows the right nav.
      try {
        localStorage.setItem('restaurant_user', JSON.stringify({
          email: d.email || '', firstName: d.firstName || '', lastName: d.lastName || '',
          role: d.role || 'SYSTEM_ADMIN', reference: d.restaurantReference || '',
          businessName: d.restaurantName || '', groupName: d.businessName || undefined,
        }))
      } catch { /* localStorage unavailable */ }
      window.location.href = '/restaurant/orders'
    } else {
      setError(d?.error || 'Unable to set password. The link may have expired.')
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#F7F8FC', fontFamily: F, padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '32px 36px', maxWidth: 420, width: '100%', boxShadow: '0 8px 40px rgba(0,0,0,0.08)' }}>
        <div style={{ marginBottom: 24 }}>
          <span style={{ fontSize: 22, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: '#999' }}> cater</span>
        </div>

        {loading && <div style={{ color: '#888', fontSize: 14 }}>Checking your invite…</div>}

        {!loading && !info?.valid && (
          <div style={{ fontSize: 14, color: '#555', lineHeight: 1.6 }}>
            This invite link has expired or is invalid. Please ask your admin to resend.
          </div>
        )}

        {!loading && info?.valid && (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 4px' }}>Welcome, {info.firstName || 'there'}!</h1>
            <p style={{ fontSize: 14, color: '#888', margin: '0 0 22px' }}>Set your password</p>

            <label style={lbl}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters"
              style={input} onKeyDown={e => { if (e.key === 'Enter') submit() }} />

            <label style={{ ...lbl, marginTop: 14 }}>Confirm password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter password"
              style={input} onKeyDown={e => { if (e.key === 'Enter') submit() }} />

            {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginTop: 14, fontSize: 13 }}>{error}</div>}

            <button onClick={submit} disabled={submitting}
              style={{ width: '100%', marginTop: 20, padding: '12px', background: INDIGO, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: submitting ? 'default' : 'pointer', fontFamily: F, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? 'Setting password…' : 'Set Password & Log In'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#F7F8FC' }} />}>
      <AcceptInviteInner />
    </Suspense>
  )
}

const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#666', display: 'block', marginBottom: 6 }
const input: React.CSSProperties = { width: '100%', border: '1.5px solid #e0e0e0', borderRadius: 8, padding: '10px 12px', fontSize: 14, fontFamily: F, color: DARK, outline: 'none', boxSizing: 'border-box' }
