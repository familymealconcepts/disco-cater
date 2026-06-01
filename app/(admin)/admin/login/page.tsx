'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#0D0D1A'
const GOLD = '#EFB84A'
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'

export default function AdminLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // Inject DM Sans
    const id = 'admin-dm-sans'
    if (!document.getElementById(id)) {
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'
      document.head.appendChild(link)
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch('/api/admin-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Login failed'); setLoading(false); return }
      try {
        localStorage.setItem('admin_user', JSON.stringify(data))
      } catch {}
      router.push('/admin/dashboard')
    } catch {
      setError('Unable to connect. Try again.')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: F, background: DARK, padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 44px',
        maxWidth: 420, width: '100%', boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <div style={{ marginBottom: 28, textAlign: 'center' }}>
          <div>
            <span style={{ fontSize: 26, fontWeight: 800, background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>disco</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: '#999' }}> cater</span>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: GOLD, letterSpacing: 1.5 }}>ADMIN</div>
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Email</label>
            <input
              type="email" required value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email" style={input} placeholder="you@discocater.com"
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={lbl}>Password</label>
            <input
              type="password" required value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password" style={input} placeholder="••••••••"
            />
          </div>
          {error && <div style={{ background: '#fff3f3', color: '#c00', padding: 10, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{error}</div>}
          <button
            type="submit" disabled={loading}
            style={{
              width: '100%', padding: '11px 18px', background: GOLD, color: DARK,
              border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer', fontFamily: F,
              opacity: loading ? 0.7 : 1, transition: 'opacity 0.15s',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div style={{ marginTop: 18, textAlign: 'center', fontSize: 12, color: '#999' }}>
          SUPER_ADMIN access only.
        </div>
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1.5px solid #e0e0e0', borderRadius: 10,
  padding: '11px 14px', fontSize: 14, fontFamily: F, color: '#1A1028', outline: 'none', background: '#fff',
}
