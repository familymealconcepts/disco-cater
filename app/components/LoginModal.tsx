'use client'
import { useState } from 'react'
import { useAuth, DiscoUser } from './useAuth'

const GRADIENT = 'linear-gradient(90deg, #6466E8 0%, #C044C8 50%, #F0468A 100%)'
const DISCO_DARK = '#1A1028'
const DISCO_PURPLE = '#6466E8'
const DISCO_PINK = '#F0468A'

interface LoginModalProps {
  onClose: () => void
  onSuccess?: () => void
}

export default function LoginModal({ onClose, onSuccess }: LoginModalProps) {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Please enter your email and password.'); return }
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/fm-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Invalid email or password.')
        setLoading(false)
        return
      }

      login(data as DiscoUser)
      onSuccess?.()
      onClose()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(26,16,40,0.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: "'DM Sans', sans-serif" }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 24, width: '100%', maxWidth: 400, padding: 32, boxShadow: '0 24px 80px rgba(0,0,0,0.2)', animation: 'fadeUp 0.2s ease' }}
        onClick={e => e.stopPropagation()}
      >
        <style>{`@keyframes fadeUp { from { opacity:0; transform:translateY(16px) } to { opacity:1; transform:translateY(0) } }`}</style>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: DISCO_DARK, letterSpacing: '-0.03em' }}>Sign in 🪩</div>
            <div style={{ fontSize: 13, color: '#727272', marginTop: 3 }}>Access your orders and saved restaurants</div>
          </div>
          <button
            onClick={onClose}
            style={{ width: 32, height: 32, borderRadius: '50%', border: 'none', background: '#f5f5f5', cursor: 'pointer', fontSize: 18, color: '#727272', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >×</button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK, display: 'block', marginBottom: 6 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoFocus
              style={{ width: '100%', padding: '12px 14px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, boxSizing: 'border-box', transition: 'border-color 0.15s' }}
              onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
              onBlur={e => e.target.style.borderColor = '#e8e8e8'}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: DISCO_DARK }}>Password</label>
              <a href="mailto:concierge@discocater.com?subject=Password%20Reset%20Request" style={{ fontSize: 12, color: DISCO_PURPLE, textDecoration: 'none' }}>Forgot password?</a>
            </div>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ width: '100%', padding: '12px 14px', fontSize: 15, border: '1.5px solid #e8e8e8', borderRadius: 12, outline: 'none', fontFamily: "'DM Sans', sans-serif", color: DISCO_DARK, boxSizing: 'border-box', transition: 'border-color 0.15s' }}
              onFocus={e => e.target.style.borderColor = DISCO_PURPLE}
              onBlur={e => e.target.style.borderColor = '#e8e8e8'}
            />
          </div>

          {error && (
            <div style={{ fontSize: 13, color: DISCO_PINK, marginBottom: 16, padding: '10px 14px', background: '#FFF0F3', borderRadius: 10, border: '1px solid #FFD0DC' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 700, color: '#fff', background: loading ? '#ccc' : DISCO_DARK, border: 'none', borderRadius: 12, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: "'DM Sans', sans-serif", transition: 'background 0.15s' }}
            onMouseOver={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_PURPLE }}
            onMouseOut={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = DISCO_DARK }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid #f5f5f5', textAlign: 'center', fontSize: 13, color: '#727272' }}>
          Use your Disco Cater account credentials to sign in.
        </div>
      </div>
    </div>
  )
}
