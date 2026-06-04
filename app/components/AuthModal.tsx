'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthContext } from '../context/AuthContext'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'

interface Props {
  isOpen: boolean
  onClose: () => void
  defaultTab?: 'login' | 'signup'
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 44,
  padding: '0 14px',
  fontSize: 14,
  border: '1px solid #e0e0e0',
  borderRadius: 8,
  outline: 'none',
  fontFamily: F,
  color: DARK,
  boxSizing: 'border-box',
  background: '#fff',
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#444',
  display: 'block',
  marginBottom: 5,
  fontFamily: F,
}

export default function AuthModal({ isOpen, onClose, defaultTab = 'login' }: Props) {
  const { login, register, pendingAction, closeAuthModal } = useAuthContext()
  const router = useRouter()
  const pathname = usePathname()
  const [tab, setTab] = useState<'login' | 'signup'>(defaultTab)

  // Login form state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginShowPw, setLoginShowPw] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Signup form state
  const [regFirst, setRegFirst] = useState('')
  const [regLast, setRegLast] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPhone, setRegPhone] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regConfirm, setRegConfirm] = useState('')
  const [regShowPw, setRegShowPw] = useState(false)
  const [regLoading, setRegLoading] = useState(false)
  const [regError, setRegError] = useState('')

  useEffect(() => {
    setTab(defaultTab)
  }, [defaultTab, isOpen])

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  if (!isOpen) return null

  function handleClose() {
    setLoginError('')
    setRegError('')
    setLoginEmail(''); setLoginPassword('')
    setRegFirst(''); setRegLast(''); setRegEmail(''); setRegPhone(''); setRegPassword(''); setRegConfirm('')
    onClose()
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail || !loginPassword) { setLoginError('Please enter your email and password.'); return }
    setLoginLoading(true); setLoginError('')
    try {
      const u = await login(loginEmail, loginPassword)
      closeAuthModal()
      handleClose()
      if (pendingAction) {
        // Finishing an interrupted action (e.g. add-to-cart / checkout) —
        // stay where they are and run it.
        pendingAction()
      } else if ((!u.role || u.role === 'USER') && !pathname?.startsWith('/restaurants/')) {
        // Mirror FM: a diner login with no pending action lands on the
        // account area (sign-in.component.ts:113-114 → USER → /account,
        // which redirects to /account/orders in Disco). Skip on restaurant
        // pages — the diner is browsing/ordering and shouldn't be punted.
        router.push('/account/orders')
      }
      // Post-login the viewport sometimes lands mid-page; snap to the top.
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    } catch (err: any) {
      setLoginError(err.message || 'Invalid email or password.')
    } finally {
      setLoginLoading(false)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!regFirst || !regLast || !regEmail || !regPassword) { setRegError('Please fill in all required fields.'); return }
    if (regPassword !== regConfirm) { setRegError('Passwords do not match.'); return }
    if (regPassword.length < 8) { setRegError('Password must be at least 8 characters.'); return }
    setRegLoading(true); setRegError('')
    try {
      await register({ email: regEmail, password: regPassword, firstName: regFirst, lastName: regLast, phoneNumber: regPhone || undefined })
      if (pendingAction) {
        pendingAction()
      }
      closeAuthModal()
      handleClose()
    } catch (err: any) {
      setRegError(err.message || 'Registration failed.')
    } finally {
      setRegLoading(false)
    }
  }

  return (
    <>
      <style>{`
        .auth-modal-input:focus { border-color: ${INDIGO} !important; box-shadow: 0 0 0 3px rgba(107,110,249,0.12) !important; }
        .auth-tab-btn { flex: 1; padding: 9px; border: none; border-radius: 8px; cursor: pointer; font-family: ${F}; font-size: 13px; transition: all 0.12s; }
        .auth-oauth-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 11px; border: 1px solid #e0e0e0; border-radius: 8px; background: #fff; cursor: pointer; font-family: ${F}; font-size: 13px; font-weight: 600; color: #333; transition: background 0.12s; }
        .auth-oauth-btn:hover { background: #f8f8f8; }
      `}</style>

      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, backdropFilter: 'blur(2px)' }}
      />

      {/* Modal card */}
      <div style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
        background: '#fff',
        borderRadius: 16,
        // 16px breathing room on each side on mobile; maxWidth still caps it at
        // 440 on desktop (unchanged there).
        width: 'calc(100% - 32px)',
        maxWidth: 440,
        padding: '32px 32px 28px',
        zIndex: 1001,
        boxShadow: '0 24px 64px rgba(0,0,0,0.18)',
        fontFamily: F,
        maxHeight: '90vh',
        overflowY: 'auto',
      }}>
        {/* Close */}
        <button
          onClick={handleClose}
          style={{ position: 'absolute', top: 16, right: 16, background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 30, height: 30, borderRadius: '50%', fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          aria-label="Close"
        >
          ×
        </button>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 4 }}>
            <span style={{ background: GRAD, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>disco</span>
            <span style={{ color: '#999' }}> cater</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: DARK, letterSpacing: '-0.02em' }}>
            {tab === 'login' ? 'Welcome back' : 'Create your account'}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', background: '#f4f4f8', borderRadius: 10, padding: 3, gap: 3, marginBottom: 24 }}>
          <button
            className="auth-tab-btn"
            onClick={() => { setTab('login'); setLoginError(''); setRegError('') }}
            style={{
              background: tab === 'login' ? '#fff' : 'transparent',
              color: tab === 'login' ? DARK : '#999',
              fontWeight: tab === 'login' ? 700 : 500,
              boxShadow: tab === 'login' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Log In
          </button>
          <button
            className="auth-tab-btn"
            onClick={() => { handleClose(); router.push('/signup') }}
            style={{
              background: tab === 'signup' ? '#fff' : 'transparent',
              color: tab === 'signup' ? DARK : '#999',
              fontWeight: tab === 'signup' ? 700 : 500,
              boxShadow: tab === 'signup' ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Sign Up
          </button>
        </div>

        {/* LOGIN FORM */}
        {tab === 'login' && (
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Email address</label>
              <input
                className="auth-modal-input"
                type="email"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="you@company.com"
                autoFocus
                autoComplete="email"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, alignItems: 'center' }}>
                <label style={labelStyle}>Password</label>
                {/* Self-service reset is blocked on FM (reset emails link to
                    familymeal.com, not discocater.com — needs a backend change).
                    Until then, route password help to the concierge inbox. */}
                <a href="mailto:concierge@discocater.com?subject=Password%20Reset%20Request" style={{ fontSize: 12, color: INDIGO, textDecoration: 'none', fontWeight: 500 }}>Forgot password?</a>
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  className="auth-modal-input"
                  type={loginShowPw ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  style={{ ...inputStyle, paddingRight: 42 }}
                />
                <button type="button" onClick={() => setLoginShowPw(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 14, padding: 0 }}>
                  {loginShowPw ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            {loginError && (
              <div style={{ fontSize: 12, color: '#E24B4A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{loginError}</div>
            )}
            <button
              type="submit"
              disabled={loginLoading}
              style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: loginLoading ? '#ccc' : DARK, border: 'none', borderRadius: 10, cursor: loginLoading ? 'not-allowed' : 'pointer', fontFamily: F, marginTop: 8 }}
            >
              {loginLoading ? 'Signing in…' : 'Log In'}
            </button>
          </form>
        )}

        {/* SIGN UP FORM */}
        {tab === 'signup' && (
          <form onSubmit={handleRegister}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={labelStyle}>First name</label>
                <input
                  className="auth-modal-input"
                  value={regFirst}
                  onChange={e => setRegFirst(e.target.value)}
                  placeholder="Jane"
                  required
                  autoFocus
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Last name</label>
                <input
                  className="auth-modal-input"
                  value={regLast}
                  onChange={e => setRegLast(e.target.value)}
                  placeholder="Smith"
                  required
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Email address</label>
              <input
                className="auth-modal-input"
                type="email"
                value={regEmail}
                onChange={e => setRegEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoComplete="email"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Phone <span style={{ color: '#aaa', fontWeight: 400 }}>(optional)</span></label>
              <input
                className="auth-modal-input"
                type="tel"
                value={regPhone}
                onChange={e => setRegPhone(e.target.value)}
                placeholder="+1 (555) 000-0000"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="auth-modal-input"
                  type={regShowPw ? 'text' : 'password'}
                  value={regPassword}
                  onChange={e => setRegPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  required
                  autoComplete="new-password"
                  style={{ ...inputStyle, paddingRight: 42 }}
                />
                <button type="button" onClick={() => setRegShowPw(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 14, padding: 0 }}>
                  {regShowPw ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>Confirm password</label>
              <input
                className="auth-modal-input"
                type="password"
                value={regConfirm}
                onChange={e => setRegConfirm(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="new-password"
                style={inputStyle}
              />
            </div>
            {regError && (
              <div style={{ fontSize: 12, color: '#E24B4A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{regError}</div>
            )}
            <button
              type="submit"
              disabled={regLoading}
              style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: regLoading ? '#ccc' : DARK, border: 'none', borderRadius: 10, cursor: regLoading ? 'not-allowed' : 'pointer', fontFamily: F, marginTop: 8 }}
            >
              {regLoading ? 'Creating account…' : 'Create Account'}
            </button>
          </form>
        )}
      </div>
    </>
  )
}
