'use client'
import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuthContext } from '../context/AuthContext'
import { sanitizePhone } from '../../lib/utils/phone'

const F = "'DM Sans', sans-serif"
const GRAD = 'linear-gradient(90deg,#6B6EF9 0%,#C044C8 50%,#F0468A 100%)'
const DARK = '#1A1028'
const INDIGO = '#6B6EF9'
const BLUE = '#5B6FE8'

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
  // 'login' shows the login form; 'forgot' replaces it with the reset-request view.
  const [mode, setMode] = useState<'login' | 'forgot'>('login')

  // Login form state
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginShowPw, setLoginShowPw] = useState(false)
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Signup form state
  const [signupFirst, setSignupFirst] = useState('')
  const [signupLast, setSignupLast] = useState('')
  const [signupEmail, setSignupEmail] = useState('')
  const [signupPhone, setSignupPhone] = useState('')
  const [signupPassword, setSignupPassword] = useState('')
  const [signupShowPw, setSignupShowPw] = useState(false)
  const [signupLoading, setSignupLoading] = useState(false)
  const [signupError, setSignupError] = useState('')

  // Forgot-password view state
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotError, setForgotError] = useState('')
  const [forgotSent, setForgotSent] = useState(false)

  useEffect(() => {
    setTab(defaultTab)
    // Always reopen on the login form, not a stale forgot view.
    setMode('login')
    setForgotEmail(''); setForgotError(''); setForgotSent(false); setForgotLoading(false)
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
    setLoginEmail(''); setLoginPassword('')
    setSignupError(''); setSignupFirst(''); setSignupLast(''); setSignupEmail(''); setSignupPhone(''); setSignupPassword('')
    setMode('login')
    setForgotEmail(''); setForgotError(''); setForgotSent(false); setForgotLoading(false)
    onClose()
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (!signupFirst || !signupLast || !signupEmail || !signupPassword) {
      setSignupError('Please fill in your name, email and password.'); return
    }
    const phoneDigits = sanitizePhone(signupPhone)
    if (!phoneDigits) { setSignupError('Phone number is required.'); return }
    if (phoneDigits.length !== 10) { setSignupError('Please enter a valid 10-digit phone number.'); return }
    if (signupPassword.length < 8) { setSignupError('Password must be at least 8 characters.'); return }
    setSignupLoading(true); setSignupError('')
    try {
      await register({
        email: signupEmail, password: signupPassword,
        firstName: signupFirst, lastName: signupLast,
        phoneNumber: phoneDigits,
      })
      closeAuthModal()
      handleClose()
      if (pendingAction) {
        // Finishing an interrupted action (e.g. checkout) — stay put and run it.
        pendingAction()
      } else if (!pathname?.startsWith('/restaurants/') && !pathname?.startsWith('/fullmap')) {
        // A new account is always a diner — mirror the login landing. Stay put on
        // the catering map and restaurant pages (close the modal, show logged in).
        router.push('/account/orders')
      }
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    } catch (err: any) {
      setSignupError(err.message || 'Could not create your account.')
    } finally {
      setSignupLoading(false)
    }
  }

  function backToLogin() {
    setMode('login')
    setForgotError(''); setForgotSent(false); setForgotLoading(false)
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault()
    if (!forgotEmail) { setForgotError('Please enter your email address.'); return }
    setForgotLoading(true); setForgotError('')
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      })
      if (!res.ok) throw new Error()
      setForgotSent(true)
    } catch {
      setForgotError('Something went wrong. Please try again.')
    } finally {
      setForgotLoading(false)
    }
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
      } else if ((!u.role || u.role === 'USER') && !pathname?.startsWith('/restaurants/') && !pathname?.startsWith('/fullmap')) {
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
            {mode === 'forgot' ? 'Reset your password' : (tab === 'login' ? 'Welcome back' : 'Create your account')}
          </div>
          {mode === 'forgot' && !forgotSent && (
            <div style={{ fontSize: 13, color: '#777', marginTop: 6, lineHeight: 1.5 }}>
              Enter your email address and we&apos;ll send you a reset link.
            </div>
          )}
        </div>

        {/* LOGIN / SIGN UP tab switcher (hidden on the forgot-password view) */}
        {mode === 'login' && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: '#f4f4f8', padding: 4, borderRadius: 10 }}>
            <button
              type="button"
              className="auth-tab-btn"
              onClick={() => { setTab('login'); setLoginError(''); setSignupError('') }}
              style={{ background: tab === 'login' ? '#fff' : 'transparent', color: tab === 'login' ? DARK : '#888', fontWeight: tab === 'login' ? 700 : 600, boxShadow: tab === 'login' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}
            >
              Log In
            </button>
            <button
              type="button"
              className="auth-tab-btn"
              onClick={() => { setTab('signup'); setLoginError(''); setSignupError('') }}
              style={{ background: tab === 'signup' ? '#fff' : 'transparent', color: tab === 'signup' ? DARK : '#888', fontWeight: tab === 'signup' ? 700 : 600, boxShadow: tab === 'signup' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}
            >
              Sign Up
            </button>
          </div>
        )}

        {/* LOGIN FORM */}
        {mode === 'login' && tab === 'login' && (
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
                <button type="button" onClick={() => { setLoginError(''); setForgotEmail(loginEmail); setMode('forgot') }}
                  style={{ fontSize: 12, color: INDIGO, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: F }}>Forgot password?</button>
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
            <div style={{ textAlign: 'center', fontSize: 12, color: '#6B7280', marginTop: 14 }}>
              <a href="/restaurant/login" style={{ color: '#6B6EF9', textDecoration: 'underline' }}>Restaurant Log in</a>
            </div>
          </form>
        )}

        {/* SIGN UP FORM */}
        {mode === 'login' && tab === 'signup' && (
          <form onSubmit={handleSignup}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>First name</label>
                <input
                  className="auth-modal-input"
                  type="text"
                  value={signupFirst}
                  onChange={e => setSignupFirst(e.target.value)}
                  placeholder="Jane"
                  autoFocus
                  autoComplete="given-name"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Last name</label>
                <input
                  className="auth-modal-input"
                  type="text"
                  value={signupLast}
                  onChange={e => setSignupLast(e.target.value)}
                  placeholder="Doe"
                  autoComplete="family-name"
                  style={inputStyle}
                />
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Email address</label>
              <input
                className="auth-modal-input"
                type="email"
                value={signupEmail}
                onChange={e => setSignupEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Phone</label>
              <input
                className="auth-modal-input"
                type="tel"
                value={signupPhone}
                onChange={e => setSignupPhone(e.target.value)}
                placeholder="(555) 123-4567"
                autoComplete="tel"
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={labelStyle}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  className="auth-modal-input"
                  type={signupShowPw ? 'text' : 'password'}
                  value={signupPassword}
                  onChange={e => setSignupPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  style={{ ...inputStyle, paddingRight: 42 }}
                />
                <button type="button" onClick={() => setSignupShowPw(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 14, padding: 0 }}>
                  {signupShowPw ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            {signupError && (
              <div style={{ fontSize: 12, color: '#E24B4A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{signupError}</div>
            )}
            <button
              type="submit"
              disabled={signupLoading}
              style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: signupLoading ? '#ccc' : DARK, border: 'none', borderRadius: 10, cursor: signupLoading ? 'not-allowed' : 'pointer', fontFamily: F, marginTop: 8 }}
            >
              {signupLoading ? 'Creating account…' : 'Create Account'}
            </button>
            <div style={{ textAlign: 'center', fontSize: 12, color: '#6B7280', marginTop: 14 }}>
              Looking to create a{' '}
              <a href="/for-restaurants" style={{ color: '#6B6EF9', textDecoration: 'underline' }}>restaurant account?</a>
            </div>
          </form>
        )}

        {/* FORGOT PASSWORD VIEW */}
        {mode === 'forgot' && (
          forgotSent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 14 }}>📬</div>
              <div style={{ fontSize: 14, color: '#444', lineHeight: 1.55, marginBottom: 22 }}>
                Check your email for a temporary password, then visit{' '}
                <a href="/reset-password" style={{ color: BLUE, fontWeight: 600 }}>discocater.com/reset-password</a>{' '}
                to set a new one.
              </div>
              <button
                type="button"
                onClick={backToLogin}
                style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: BLUE, border: 'none', borderRadius: 999, cursor: 'pointer', fontFamily: F }}
              >
                Back to login
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgot}>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Email address</label>
                <input
                  className="auth-modal-input"
                  type="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder="you@company.com"
                  autoFocus
                  autoComplete="email"
                  style={{ ...inputStyle, borderRadius: 999, padding: '0 18px' }}
                />
              </div>
              {forgotError && (
                <div style={{ fontSize: 12, color: '#E24B4A', marginBottom: 14, padding: '9px 12px', background: '#FFF0F3', borderRadius: 8 }}>{forgotError}</div>
              )}
              <button
                type="submit"
                disabled={forgotLoading}
                style={{ width: '100%', padding: '13px', fontSize: 14, fontWeight: 700, color: '#fff', background: forgotLoading ? '#ccc' : BLUE, border: 'none', borderRadius: 999, cursor: forgotLoading ? 'not-allowed' : 'pointer', fontFamily: F, marginTop: 4 }}
              >
                {forgotLoading ? 'Sending…' : 'Send reset link'}
              </button>
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button type="button" onClick={backToLogin}
                  style={{ fontSize: 13, color: INDIGO, fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', fontFamily: F }}>
                  ← Back to login
                </button>
              </div>
            </form>
          )
        )}
      </div>
    </>
  )
}
